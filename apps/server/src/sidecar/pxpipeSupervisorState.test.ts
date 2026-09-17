import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";

import {
  MAX_HEALTH_FAILURES,
  MAX_RESTART_ATTEMPTS,
  initialPxpipeSupervisorState,
  pxpipeRestartDelay,
  pxpipeSupervisorTransition,
  toPxpipeSidecarState,
  type PxpipeSupervisorEvent,
  type PxpipeSupervisorPhase,
  type PxpipeSupervisorState,
} from "./pxpipeSupervisorState.ts";

const enabled = pxpipeSupervisorTransition(initialPxpipeSupervisorState, {
  _tag: "settingsChanged",
  enabled: true,
  port: 47821,
});

const drive = (
  state: PxpipeSupervisorState,
  ...events: ReadonlyArray<PxpipeSupervisorEvent>
): PxpipeSupervisorState => events.reduce(pxpipeSupervisorTransition, state);

const healthy = drive(
  enabled,
  { _tag: "spawned", pid: 4321, version: "0.13.2" },
  { _tag: "healthCheckPassed" },
);

const failingHealth: PxpipeSupervisorEvent = {
  _tag: "healthCheckFailed",
  error: "connect ECONNREFUSED",
};

describe("pxpipeSupervisorTransition", () => {
  const edges: ReadonlyArray<{
    readonly name: string;
    readonly from: PxpipeSupervisorState;
    readonly events: ReadonlyArray<PxpipeSupervisorEvent>;
    readonly phase: PxpipeSupervisorPhase;
  }> = [
    {
      name: "disabled to starting when settings enable it",
      from: initialPxpipeSupervisorState,
      events: [{ _tag: "settingsChanged", enabled: true, port: 47821 }],
      phase: "starting",
    },
    {
      name: "stopped to starting on a manual start",
      from: drive(healthy, { _tag: "stopRequested" }),
      events: [{ _tag: "startRequested" }],
      phase: "starting",
    },
    {
      name: "starting to healthy on the first 2xx",
      from: enabled,
      events: [{ _tag: "spawned", pid: 4321, version: "0.13.2" }, { _tag: "healthCheckPassed" }],
      phase: "healthy",
    },
    {
      name: "starting to unhealthy on a spawn error",
      from: enabled,
      events: [{ _tag: "startFailed", error: "pxpipe did not bind port 47821." }],
      phase: "unhealthy",
    },
    {
      name: "healthy holds under the failure threshold",
      from: healthy,
      events: Array.from({ length: MAX_HEALTH_FAILURES - 1 }, () => failingHealth),
      phase: "healthy",
    },
    {
      name: "healthy to unhealthy once the threshold is reached",
      from: healthy,
      events: Array.from({ length: MAX_HEALTH_FAILURES }, () => failingHealth),
      phase: "unhealthy",
    },
    {
      name: "healthy to backoff when the process exits",
      from: healthy,
      events: [{ _tag: "processExited", error: "pxpipe exited with code 1." }],
      phase: "backoff",
    },
    {
      name: "unhealthy to backoff when the process exits",
      from: drive(healthy, ...Array.from({ length: MAX_HEALTH_FAILURES }, () => failingHealth)),
      events: [{ _tag: "processExited", error: "pxpipe exited with code 1." }],
      phase: "backoff",
    },
    {
      name: "backoff to starting once the delay elapses",
      from: drive(healthy, { _tag: "processExited", error: "pxpipe exited with code 1." }),
      events: [{ _tag: "backoffElapsed" }],
      phase: "starting",
    },
    {
      name: "a settings change restarts a healthy sidecar",
      from: healthy,
      events: [{ _tag: "settingsChanged", enabled: true, port: 47822 }],
      phase: "starting",
    },
    {
      name: "a settings change that disables it stops the process",
      from: healthy,
      events: [{ _tag: "settingsChanged", enabled: false, port: 47821 }],
      phase: "disabled",
    },
    {
      name: "a stop while enabled reports stopped, not disabled",
      from: healthy,
      events: [{ _tag: "stopRequested" }],
      phase: "stopped",
    },
    {
      name: "a stop while disabled stays disabled",
      from: drive(initialPxpipeSupervisorState, { _tag: "startRequested" }),
      events: [{ _tag: "stopRequested" }],
      phase: "disabled",
    },
    {
      name: "an exit after a stop is ignored: we took it down on purpose",
      from: drive(healthy, { _tag: "stopRequested" }),
      events: [{ _tag: "processExited", error: "pxpipe exited with code 0." }],
      phase: "stopped",
    },
  ];

  for (const edge of edges) {
    it(edge.name, () => {
      expect(drive(edge.from, ...edge.events).phase).toBe(edge.phase);
    });
  }

  it("gives up in failed once the restart attempts are exhausted", () => {
    let state = healthy;
    for (let attempt = 1; attempt <= MAX_RESTART_ATTEMPTS; attempt += 1) {
      state = drive(state, { _tag: "processExited", error: `exit ${attempt}` });
      if (attempt < MAX_RESTART_ATTEMPTS) {
        expect(state.phase).toBe("backoff");
        state = drive(state, { _tag: "backoffElapsed" });
      }
    }
    expect(state.phase).toBe("failed");
    expect(state.restartCount).toBe(MAX_RESTART_ATTEMPTS);
    // The page needs a reason to show beside its Start button, not a spinner.
    expect(state.lastError).toBe(`exit ${MAX_RESTART_ATTEMPTS}`);
  });

  it("resets the attempt counter on a manual start", () => {
    let state = healthy;
    for (let attempt = 1; attempt <= MAX_RESTART_ATTEMPTS; attempt += 1) {
      state = drive(state, { _tag: "processExited", error: `exit ${attempt}` });
      state = drive(state, { _tag: "backoffElapsed" });
    }
    expect(state.restartCount).toBe(MAX_RESTART_ATTEMPTS);

    const restarted = drive(state, { _tag: "startRequested" });
    expect(restarted.phase).toBe("starting");
    expect(restarted.restartCount).toBe(0);
  });

  it("reaching healthy clears the restart count so the next outage starts over", () => {
    const recovered = drive(
      healthy,
      { _tag: "processExited", error: "exit 1" },
      { _tag: "backoffElapsed" },
      { _tag: "spawned", pid: 99, version: "0.13.2" },
      { _tag: "healthCheckPassed" },
    );
    expect(recovered.restartCount).toBe(0);
    expect(recovered.lastError).toBeNull();
  });

  it("adopts a process it did not start and claims no pid or version for it", () => {
    const adopted = drive(enabled, { _tag: "adopted" });
    expect(adopted).toMatchObject({
      phase: "healthy",
      adopted: true,
      pid: null,
      version: "",
    });
  });

  it("drops the adopted flag once the sidecar is stopped", () => {
    const stopped = drive(enabled, { _tag: "adopted" }, { _tag: "stopRequested" });
    expect(stopped.adopted).toBe(false);
  });

  it("ignores a spawn reported outside a start attempt", () => {
    const stopped = drive(healthy, { _tag: "stopRequested" });
    expect(drive(stopped, { _tag: "spawned", pid: 7, version: "0.13.2" }).pid).toBeNull();
  });

  it("does not count a refused probe while starting: the start timeout decides", () => {
    const starting = drive(enabled, { _tag: "spawned", pid: 4321, version: "0.13.2" });
    expect(drive(starting, failingHealth, failingHealth, failingHealth).phase).toBe("starting");
  });
});

describe("pxpipeRestartDelay", () => {
  it("doubles per restart and caps", () => {
    expect(Duration.toMillis(pxpipeRestartDelay(1))).toBe(500);
    expect(Duration.toMillis(pxpipeRestartDelay(2))).toBe(1_000);
    expect(Duration.toMillis(pxpipeRestartDelay(3))).toBe(2_000);
    expect(Duration.toMillis(pxpipeRestartDelay(99))).toBe(10_000);
  });
});

describe("toPxpipeSidecarState", () => {
  it("reports a sidecar waiting out its backoff as unhealthy with a reason", () => {
    const backoff = drive(healthy, { _tag: "processExited", error: "pxpipe exited with code 1." });
    expect(toPxpipeSidecarState(backoff)).toMatchObject({
      status: "unhealthy",
      pid: null,
      lastError: "pxpipe exited with code 1.",
    });
  });

  it("turns an empty reason into no reason", () => {
    const blank = drive(healthy, { _tag: "processExited", error: "   " });
    expect(toPxpipeSidecarState(blank).lastError).toBeNull();
  });
});
