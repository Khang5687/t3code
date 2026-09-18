/**
 * Supervises the environment's one pxpipe sidecar (ADR 0004): starts it at
 * boot when settings enable it, health-checks `GET /proxy-stats`, restarts it
 * with capped backoff, and stops it when a client or a settings change says
 * to. Everything a client sees comes from one state, so two clients cannot
 * disagree about one process.
 *
 * A pxpipe the user started themselves on the configured port is adopted:
 * answered, reported, and left alone. Adoption is structural — the adopted
 * path never acquires a process handle, so nothing can kill it.
 *
 * The state machine lives in `pxpipeSupervisorState.ts`; this file is the
 * transport and the effects.
 */
import {
  type PxpipeProxyStats,
  type PxpipeSidecarSettings,
  type PxpipeSidecarState,
  SidecarOperationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  PINNED_PXPIPE_VERSION,
  pxpipeVersionsDir,
  removePxpipeVersion,
  resolvePxpipeBinary,
} from "./pxpipeVersionCache.ts";
import {
  initialPxpipeSupervisorState,
  isPxpipeSupervisorRunning,
  pxpipeRestartDelay,
  pxpipeSupervisorTransition,
  toPxpipeSidecarState,
  type PxpipeSupervisorEvent,
  type PxpipeSupervisorState,
} from "./pxpipeSupervisorState.ts";

/** One probe waits this long before it counts as a failure. */
const PROBE_TIMEOUT = Duration.seconds(2);
/** Poll cadence while waiting for a freshly spawned process to answer. */
const STARTING_POLL_INTERVAL = Duration.seconds(2);
/** Poll cadence once it has answered. */
const HEALTHY_POLL_INTERVAL = Duration.seconds(10);
/** A process that has not answered by now never bound its port. */
const START_TIMEOUT = Duration.seconds(30);
/** Typing in the port field must not restart the process on every keystroke. */
const SETTINGS_DEBOUNCE = Duration.seconds(1);

export class PxpipeSidecar extends Context.Service<
  PxpipeSidecar,
  {
    readonly state: Effect.Effect<PxpipeSidecarState>;
    /** Start or stop the process without changing whether settings enable it. */
    readonly setRunning: (running: boolean) => Effect.Effect<PxpipeSidecarState>;
    /** pxpipe's own `GET /proxy-stats` over loopback, or null when nothing answers. */
    readonly stats: Effect.Effect<PxpipeProxyStats | null>;
    readonly removeCache: (
      version?: string | undefined,
    ) => Effect.Effect<{ readonly removedVersions: ReadonlyArray<string> }, SidecarOperationError>;
  }
>()("t3/sidecar/PxpipeSidecar") {}

/** Why an attempt ended, which decides the event the supervisor loop applies. */
type AttemptOutcome =
  | { readonly _tag: "startFailed"; readonly error: string }
  | { readonly _tag: "ended"; readonly error: string };

const decodeProxyStats = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));

/**
 * pxpipe takes environment variables only — it has no argv flags (captain
 * ruling Q1). `HOST` is deliberately absent: the sidecar binds loopback, and
 * opening another interface is a non-goal of ADR 0004. A user who wants it
 * anyway can put it on `extraEnv`.
 */
export function pxpipeSpawnEnvironment(settings: PxpipeSidecarSettings): Record<string, string> {
  const env: Record<string, string> = { PORT: String(settings.port) };
  if (settings.anthropicUpstream !== "") env["ANTHROPIC_UPSTREAM"] = settings.anthropicUpstream;
  if (settings.models.length > 0) env["PXPIPE_MODELS"] = settings.models.join(",");
  if (settings.logPath !== "") env["PXPIPE_LOG"] = settings.logPath;
  for (const variable of settings.extraEnv) env[variable.name] = variable.value;
  return env;
}

export const make = Effect.fn("sidecar.pxpipe.make")(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runner = yield* ProcessRunner.ProcessRunner;
  const httpClient = yield* HttpClient.HttpClient;

  const stateRef = yield* Ref.make(initialPxpipeSupervisorState);
  const commands = yield* Queue.unbounded<PxpipeSupervisorEvent>();

  const apply = (event: PxpipeSupervisorEvent): Effect.Effect<PxpipeSupervisorState> =>
    Ref.updateAndGet(stateRef, (current) => pxpipeSupervisorTransition(current, event));

  /** A remote client never talks to `127.0.0.1`; the server relays for it. */
  const probe = (port: number): Effect.Effect<Option.Option<PxpipeProxyStats>> =>
    httpClient.get(`http://127.0.0.1:${port}/proxy-stats`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(PROBE_TIMEOUT),
      Effect.map(decodeProxyStats),
      Effect.catchCause(() => Effect.succeed(Option.none<PxpipeProxyStats>())),
    );

  const pxpipeSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.sidecars.pxpipe),
    Effect.catchCause(() => Effect.succeed(null)),
  );

  /**
   * Polls until something ends the attempt. `stopWhenUnhealthy` is the adopted
   * case: there is no process handle to watch, so a proxy that stopped
   * answering is how we learn it is gone and can take over with our own.
   */
  const pollHealth = (
    port: number,
    interval: Duration.Duration,
    stopWhenUnhealthy: boolean,
  ): Effect.Effect<AttemptOutcome> =>
    Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(interval);
        const stats = yield* probe(port);
        const next = yield* apply(
          Option.isSome(stats)
            ? { _tag: "healthCheckPassed" }
            : {
                _tag: "healthCheckFailed",
                error: `pxpipe stopped answering GET /proxy-stats on port ${port}.`,
              },
        );
        if (stopWhenUnhealthy && next.phase === "unhealthy") {
          return {
            _tag: "ended",
            error: next.lastError ?? `pxpipe stopped answering on port ${port}.`,
          } satisfies AttemptOutcome;
        }
      }
    });

  /** Polls at the starting cadence until a 2xx, or gives up at the start timeout. */
  const awaitFirstHealthy = (port: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      while (true) {
        const stats = yield* probe(port);
        if (Option.isSome(stats)) return true;
        yield* Effect.sleep(STARTING_POLL_INTERVAL);
      }
    }).pipe(Effect.timeoutOption(START_TIMEOUT), Effect.map(Option.isSome));

  const runAttempt = (settings: PxpipeSidecarSettings): Effect.Effect<AttemptOutcome> =>
    Effect.scoped(
      Effect.gen(function* () {
        const port = settings.port;

        // Probe before spawning. Something already serving this port is the
        // user's own pxpipe: use it, never supervise it, never kill it.
        if (Option.isSome(yield* probe(port))) {
          yield* apply({ _tag: "adopted" });
          return yield* pollHealth(port, HEALTHY_POLL_INTERVAL, true);
        }

        const resolved = yield* Effect.result(
          resolvePxpipeBinary({
            baseDir: config.baseDir,
            version: PINNED_PXPIPE_VERSION,
            fs,
            path,
            runner,
            binaryPath: settings.binaryPath,
          }),
        );
        if (Result.isFailure(resolved)) {
          return { _tag: "startFailed", error: resolved.failure.message } satisfies AttemptOutcome;
        }
        const binary = resolved.success;

        const command = ChildProcess.make(binary.path, [], {
          cwd: config.cwd,
          env: pxpipeSpawnEnvironment(settings),
          extendEnv: true,
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(2),
        });
        const spawned = yield* Effect.acquireRelease(
          // Kept in the success channel so the release runs for the handle we
          // did get, and so a failed spawn reads as one more attempt outcome.
          Effect.result(spawner.spawn(command)),
          (handle) =>
            Result.isSuccess(handle) ? handle.success.kill().pipe(Effect.ignore) : Effect.void,
        );
        if (Result.isFailure(spawned)) {
          return {
            _tag: "startFailed",
            error: `Could not start pxpipe from ${binary.path} for port ${port}: ${spawned.failure.message}`,
          } satisfies AttemptOutcome;
        }
        const handle = spawned.success;
        yield* apply({ _tag: "spawned", pid: handle.pid, version: binary.version });
        // pxpipe writes its own log; draining keeps a full pipe from wedging it.
        yield* handle.stdout.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
        yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

        const exited = handle.exitCode.pipe(
          Effect.map((code) => `pxpipe exited with code ${String(code)}.`),
          Effect.catchCause(() => Effect.succeed("pxpipe stopped unexpectedly.")),
          Effect.map((error) => ({ _tag: "ended", error }) satisfies AttemptOutcome),
        );

        const start = Effect.gen(function* () {
          if (!(yield* awaitFirstHealthy(port))) {
            return {
              _tag: "startFailed",
              // Naming the port is the whole message: a failed bind reads as
              // "nothing ever answered here".
              error: `pxpipe did not answer GET /proxy-stats on port ${port} within ${Duration.toSeconds(START_TIMEOUT)}s. Another process may hold the port.`,
            } satisfies AttemptOutcome;
          }
          yield* apply({ _tag: "healthCheckPassed" });
          return yield* pollHealth(port, HEALTHY_POLL_INTERVAL, false);
        });

        return yield* Effect.raceFirst(start, exited);
      }),
    );

  const supervisor = Effect.gen(function* () {
    while (true) {
      const current = yield* Ref.get(stateRef);
      if (current.phase === "starting") {
        const settings = yield* pxpipeSettings;
        if (settings === null) {
          yield* apply({ _tag: "startFailed", error: "Server settings are unreadable." });
          yield* apply({ _tag: "processExited", error: "Server settings are unreadable." });
          continue;
        }
        const raced = yield* Effect.raceFirst(
          runAttempt(settings).pipe(Effect.map((outcome) => ({ outcome }) as const)),
          // A stop, a disable or a settings change interrupts the attempt, and
          // the scope it runs in kills whatever it spawned.
          Queue.take(commands).pipe(Effect.map((event) => ({ event }) as const)),
        );
        if ("event" in raced) {
          yield* apply(raced.event);
          continue;
        }
        const { outcome } = raced;
        if (outcome._tag === "startFailed") {
          // `starting -> unhealthy` on a spawn error, then straight on: a start
          // that failed left no process, so nothing else will report an exit.
          yield* apply({ _tag: "startFailed", error: outcome.error });
        }
        yield* apply({ _tag: "processExited", error: outcome.error });
        continue;
      }
      if (current.phase === "backoff") {
        const event = yield* Effect.raceFirst(
          Effect.sleep(pxpipeRestartDelay(current.restartCount)).pipe(
            Effect.as<PxpipeSupervisorEvent>({ _tag: "backoffElapsed" }),
          ),
          Queue.take(commands),
        );
        yield* apply(event);
        continue;
      }
      yield* apply(yield* Queue.take(commands));
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Ref.update(stateRef, (state) => ({
            ...state,
            phase: "failed" as const,
            pid: null,
            adopted: false,
            lastError: "The pxpipe supervisor stopped unexpectedly.",
          })).pipe(
            Effect.andThen(
              Effect.logWarning("pxpipe supervisor failed", { cause: Cause.pretty(cause) }),
            ),
          ),
    ),
  );

  const settingsChangedEvent = (settings: PxpipeSidecarSettings): PxpipeSupervisorEvent => ({
    _tag: "settingsChanged",
    enabled: settings.enabled,
    port: settings.port,
  });

  const watchSettings = Effect.gen(function* () {
    const changes = yield* settingsService.subscribeChanges;
    yield* changes.pipe(
      Stream.map((settings) => settings.sidecars.pxpipe),
      Stream.debounce(SETTINGS_DEBOUNCE),
      // ponytail: JSON equality over one small settings blob, both sides
      // produced by the same decoder so key order matches. A structural
      // comparison is only worth writing if this blob grows nested optionals.
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      Stream.runForEach((settings) => Queue.offer(commands, settingsChangedEvent(settings))),
    );
  });

  const cachedVersions = fs.readDirectory(pxpipeVersionsDir(path, config.baseDir)).pipe(
    // Staging directories belong to an install in flight, not to a version.
    Effect.map((entries) => entries.filter((entry) => !entry.startsWith("."))),
    Effect.catchCause(() => Effect.succeed<ReadonlyArray<string>>([])),
  );

  const removeCache = Effect.fn("sidecar.pxpipe.removeCache")(function* (
    version?: string | undefined,
  ) {
    const current = yield* Ref.get(stateRef);
    if (isPxpipeSupervisorRunning(current.phase)) {
      return yield* new SidecarOperationError({
        message: "Stop the pxpipe sidecar before removing its cached installs.",
      });
    }
    const versions = version === undefined ? yield* cachedVersions : [version];
    const removedVersions: Array<string> = [];
    for (const candidate of versions) {
      const result = yield* removePxpipeVersion({
        baseDir: config.baseDir,
        version: candidate,
        fs,
        path,
      }).pipe(Effect.mapError((error) => new SidecarOperationError({ message: error.message })));
      if (result.removed) removedVersions.push(candidate);
    }
    return { removedVersions };
  });

  // Boot: settings decide whether the process starts, before anything is forked,
  // so a server that comes up enabled is already in `starting`.
  const booted = yield* pxpipeSettings;
  if (booted !== null) yield* apply(settingsChangedEvent(booted));

  yield* Effect.forkScoped(supervisor);
  yield* Effect.forkScoped(watchSettings);

  return {
    state: Ref.get(stateRef).pipe(Effect.map(toPxpipeSidecarState)),
    setRunning: (running: boolean) => {
      const event: PxpipeSupervisorEvent = {
        _tag: running ? "startRequested" : "stopRequested",
      };
      // Applied here and queued for the supervisor. Both transitions are
      // idempotent, and applying first is what lets the caller see the phase it
      // asked for instead of the one it replaced.
      return apply(event).pipe(
        Effect.tap(() => Queue.offer(commands, event)),
        Effect.map(toPxpipeSidecarState),
      );
    },
    stats: Ref.get(stateRef).pipe(
      Effect.flatMap((state) => probe(state.port)),
      Effect.map(Option.getOrNull),
    ),
    removeCache,
  } satisfies PxpipeSidecar["Service"];
});

export const layer = Layer.effect(PxpipeSidecar, make());

/** A sidecar that never runs, for tests that only need the RPC surface. */
export const layerTest = Layer.succeed(PxpipeSidecar, {
  state: Effect.succeed(toPxpipeSidecarState(initialPxpipeSupervisorState)),
  setRunning: () => Effect.succeed(toPxpipeSidecarState(initialPxpipeSupervisorState)),
  stats: Effect.succeed(null),
  removeCache: () => Effect.succeed({ removedVersions: [] }),
});
