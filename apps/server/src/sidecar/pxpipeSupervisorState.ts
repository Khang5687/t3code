/**
 * The pxpipe supervisor's state machine, kept pure and apart from the runtime
 * so every edge is exercised without spawning a process or opening a socket.
 * `PxpipeSidecar.ts` feeds it events and acts on the phase it lands in.
 *
 * `backoff` is a phase, not a client-visible status: to a client a sidecar
 * waiting out its restart delay is `unhealthy` with a reason, which is what
 * `toPxpipeSidecarState` reports.
 */
import { DEFAULT_PXPIPE_SIDECAR_PORT, type PxpipeSidecarState } from "@t3tools/contracts";
import * as Duration from "effect/Duration";

export type PxpipeSupervisorPhase =
  | "disabled"
  | "stopped"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "backoff"
  | "failed";

export interface PxpipeSupervisorState {
  readonly phase: PxpipeSupervisorPhase;
  /** What settings say. A manual start runs the process with this still false. */
  readonly enabled: boolean;
  readonly port: number;
  /** Empty for an adopted process or a `binaryPath` override: T3 did not install it. */
  readonly version: string;
  readonly pid: number | null;
  /** A pxpipe already on the port when we probed. Used, never supervised, never killed. */
  readonly adopted: boolean;
  /** Restarts since the sidecar was last healthy; also drives the backoff delay. */
  readonly restartCount: number;
  readonly healthFailures: number;
  readonly lastError: string | null;
}

export type PxpipeSupervisorEvent =
  /** Settings moved in a way the running process depends on. Stops, then starts. */
  | { readonly _tag: "settingsChanged"; readonly enabled: boolean; readonly port: number }
  /** A client pressed Start. Resets the attempt counter, even from `failed`. */
  | { readonly _tag: "startRequested" }
  | { readonly _tag: "stopRequested" }
  /** `GET /proxy-stats` answered before we spawned anything. */
  | { readonly _tag: "adopted" }
  | { readonly _tag: "spawned"; readonly pid: number; readonly version: string }
  | { readonly _tag: "healthCheckPassed" }
  | { readonly _tag: "healthCheckFailed"; readonly error: string }
  /** Install, spawn or start timeout failed. No process exists after this. */
  | { readonly _tag: "startFailed"; readonly error: string }
  | { readonly _tag: "processExited"; readonly error: string }
  | { readonly _tag: "backoffElapsed" };

/** Consecutive failed polls that take a running process from healthy to unhealthy. */
export const MAX_HEALTH_FAILURES = 3;
/** Restarts before the supervisor gives up and waits for a manual start. */
export const MAX_RESTART_ATTEMPTS = 5;
const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);

/** Doubles per restart, capped. Same shape as the resource telemetry supervisor. */
export function pxpipeRestartDelay(restartCount: number): Duration.Duration {
  return Duration.min(
    Duration.times(INITIAL_RESTART_DELAY, 2 ** Math.max(0, restartCount - 1)),
    MAX_RESTART_DELAY,
  );
}

export const initialPxpipeSupervisorState: PxpipeSupervisorState = {
  phase: "disabled",
  enabled: false,
  port: DEFAULT_PXPIPE_SIDECAR_PORT,
  version: "",
  pid: null,
  adopted: false,
  restartCount: 0,
  healthFailures: 0,
  lastError: null,
};

/** A phase with a process attached, or one attempt away from having one. */
export function isPxpipeSupervisorRunning(phase: PxpipeSupervisorPhase): boolean {
  return (
    phase === "starting" || phase === "healthy" || phase === "unhealthy" || phase === "backoff"
  );
}

/** Clears everything tied to a process that no longer exists. */
function detached(
  state: PxpipeSupervisorState,
  phase: PxpipeSupervisorPhase,
  lastError: string | null,
): PxpipeSupervisorState {
  return { ...state, phase, pid: null, adopted: false, healthFailures: 0, lastError };
}

export function pxpipeSupervisorTransition(
  state: PxpipeSupervisorState,
  event: PxpipeSupervisorEvent,
): PxpipeSupervisorState {
  switch (event._tag) {
    case "settingsChanged": {
      const moved = { ...state, enabled: event.enabled, port: event.port, restartCount: 0 };
      return detached(moved, event.enabled ? "starting" : "disabled", null);
    }
    case "startRequested":
      return detached({ ...state, restartCount: 0 }, "starting", null);
    case "stopRequested":
      return detached({ ...state, restartCount: 0 }, state.enabled ? "stopped" : "disabled", null);
    case "adopted":
      return {
        ...state,
        phase: "healthy",
        // We did not install this process, so we cannot claim a version for it.
        version: "",
        pid: null,
        adopted: true,
        restartCount: 0,
        healthFailures: 0,
        lastError: null,
      };
    case "spawned":
      // Still `starting`: the process exists but has not answered a probe yet.
      return state.phase === "starting"
        ? { ...state, pid: event.pid, version: event.version, adopted: false }
        : state;
    case "healthCheckPassed":
      return state.phase === "starting" || state.phase === "healthy" || state.phase === "unhealthy"
        ? { ...state, phase: "healthy", restartCount: 0, healthFailures: 0, lastError: null }
        : state;
    case "healthCheckFailed": {
      // While starting, a refused probe is expected; the start timeout decides.
      if (state.phase !== "healthy" && state.phase !== "unhealthy") return state;
      const healthFailures = state.healthFailures + 1;
      return healthFailures >= MAX_HEALTH_FAILURES
        ? { ...state, phase: "unhealthy", healthFailures, lastError: event.error }
        : { ...state, healthFailures };
    }
    case "startFailed":
      return state.phase === "starting" ? detached(state, "unhealthy", event.error) : state;
    case "processExited": {
      // A stop or a disable already took the process down on purpose.
      if (!isPxpipeSupervisorRunning(state.phase)) return state;
      const restartCount = state.restartCount + 1;
      return detached(
        { ...state, restartCount },
        restartCount >= MAX_RESTART_ATTEMPTS ? "failed" : "backoff",
        event.error,
      );
    }
    case "backoffElapsed":
      return state.phase === "backoff" ? detached(state, "starting", state.lastError) : state;
  }
}

function toSidecarStatus(phase: PxpipeSupervisorPhase): PxpipeSidecarState["status"] {
  // A sidecar waiting out its restart delay is down with a reason, and the page
  // renders that the same way it renders a failing health check.
  return phase === "backoff" ? "unhealthy" : phase;
}

/** The projection clients see. `pid` stays null for an adopted process. */
export function toPxpipeSidecarState(state: PxpipeSupervisorState): PxpipeSidecarState {
  return {
    status: toSidecarStatus(state.phase),
    port: state.port,
    version: state.version,
    pid: state.pid,
    adopted: state.adopted,
    restartCount: state.restartCount,
    // `TrimmedNonEmptyString | null`: an empty reason is no reason.
    lastError:
      state.lastError === null || state.lastError.trim() === "" ? null : state.lastError.trim(),
  };
}
