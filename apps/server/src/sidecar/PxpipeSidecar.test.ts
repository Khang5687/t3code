import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PxpipeSidecar, layer, pxpipeSpawnEnvironment } from "./PxpipeSidecar.ts";
import { MAX_RESTART_ATTEMPTS } from "./pxpipeSupervisorState.ts";

const PORT = 47821;

/** Answers `GET /proxy-stats` while `answering` is true, and 503s otherwise. */
const httpClientLayer = (answering: Ref.Ref<boolean>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Ref.get(answering).pipe(
        Effect.map((ok) =>
          HttpClientResponse.fromWeb(
            request,
            ok
              ? new Response(JSON.stringify({ requests: 802, saved_pct: 65.1 }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                })
              : new Response("", { status: 503 }),
          ),
        ),
      ),
    ),
  );

/** Counts spawns, and dies rather than pretending a process exists. */
const refusingSpawnerLayer = (spawns: Ref.Ref<number>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Ref.update(spawns, (count) => count + 1).pipe(
        Effect.andThen(Effect.die("the supervisor spawned a process it should have adopted")),
      ),
    ),
  );

/** A pxpipe that starts but never binds its port, so nothing ever answers. */
const silentSpawnerLayer = (killed: Deferred.Deferred<void>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Deferred.await(exited),
          isRunning: Effect.succeed(true),
          kill: () =>
            Deferred.succeed(killed, undefined).pipe(
              Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
              Effect.asVoid,
            ),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed<ChildProcessSpawner.Reref>(Effect.void),
        });
      }),
    ),
  );

const sidecarLayer = (input: {
  readonly baseDir: string;
  readonly binaryPath: string;
  readonly spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly answering: Ref.Ref<boolean>;
}) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), input.baseDir),
        ServerSettings.layerTest({
          sidecars: { pxpipe: { enabled: true, port: PORT, binaryPath: input.binaryPath } },
        }),
        input.spawner,
        httpClientLayer(input.answering),
        ProcessRunner.layer,
      ),
    ),
  );

it.layer(NodeServices.layer)("pxpipe sidecar supervisor", (it) => {
  it.effect("adopts a pxpipe already on the port and never spawns or kills one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-adopt-" });
      const answering = yield* Ref.make(true);
      const spawns = yield* Ref.make(0);

      yield* Effect.provide(
        Effect.gen(function* () {
          const sidecar = yield* PxpipeSidecar;
          // Let the supervisor probe and take its first steady poll.
          yield* TestClock.adjust(Duration.seconds(10));

          const adopted = yield* sidecar.state;
          assert.strictEqual(adopted.status, "healthy");
          assert.isTrue(adopted.adopted);
          // No pid and no version: T3 Code did not start this process.
          assert.strictEqual(adopted.pid, null);
          assert.strictEqual(adopted.version, "");

          const stopped = yield* sidecar.setRunning(false);
          assert.strictEqual(stopped.status, "stopped");
          assert.isFalse(stopped.adopted);
          // The adopted path never acquired a handle, so a stop had nothing to
          // kill and the user's own proxy is still up.
          assert.strictEqual(yield* Ref.get(spawns), 0);
          assert.isTrue(yield* Ref.get(answering));
        }),
        sidecarLayer({
          baseDir,
          binaryPath: "/nonexistent/pxpipe",
          spawner: refusingSpawnerLayer(spawns),
          answering,
        }),
      );
    }),
  );

  it.effect("refuses to drop cached installs while the sidecar is running", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-cache-" });
      const answering = yield* Ref.make(true);
      const spawns = yield* Ref.make(0);

      yield* Effect.provide(
        Effect.gen(function* () {
          const sidecar = yield* PxpipeSidecar;
          yield* TestClock.adjust(Duration.seconds(10));
          assert.strictEqual((yield* sidecar.state).status, "healthy");

          const refused = yield* Effect.flip(sidecar.removeCache());
          assert.include(refused.message, "Stop the pxpipe sidecar");

          yield* sidecar.setRunning(false);
          const removed = yield* sidecar.removeCache();
          assert.deepStrictEqual(removed.removedVersions, []);
        }),
        sidecarLayer({
          baseDir,
          binaryPath: "/nonexistent/pxpipe",
          spawner: refusingSpawnerLayer(spawns),
          answering,
        }),
      );
    }),
  );

  it.effect("gives up naming the port when a spawned pxpipe never answers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-timeout-" });
      const answering = yield* Ref.make(false);
      const killed = yield* Deferred.make<void>();

      yield* Effect.provide(
        Effect.gen(function* () {
          const sidecar = yield* PxpipeSidecar;
          // Long enough for every attempt's 30s start timeout and the capped
          // backoff between them, so the run lands on its terminal phase.
          yield* TestClock.adjust(Duration.minutes(5));

          const state = yield* sidecar.state;
          // Exhausted, so the page shows a reason and a Start button rather
          // than a spinner that lies.
          assert.strictEqual(state.status, "failed");
          assert.strictEqual(state.restartCount, MAX_RESTART_ATTEMPTS);
          assert.include(state.lastError ?? "", String(PORT));
          // The supervisor spawned these, so giving up killed them.
          assert.isTrue(yield* Deferred.isDone(killed));

          // A manual start clears the attempt counter and tries again.
          const restarted = yield* sidecar.setRunning(true);
          assert.strictEqual(restarted.status, "starting");
          assert.strictEqual(restarted.restartCount, 0);
        }),
        sidecarLayer({
          baseDir,
          binaryPath: "/fake/pxpipe",
          spawner: silentSpawnerLayer(killed),
          answering,
        }),
      );
    }),
  );
});

it("maps the typed settings core onto pxpipe's environment variables", () => {
  const env = pxpipeSpawnEnvironment({
    enabled: true,
    port: 47822,
    models: ["off"],
    logPath: "/tmp/pxpipe.log",
    binaryPath: "",
    anthropicUpstream: "http://localhost:8080",
    extraEnv: [{ name: "HOST", value: "0.0.0.0", sensitive: false }],
  });
  assert.deepStrictEqual(env, {
    PORT: "47822",
    ANTHROPIC_UPSTREAM: "http://localhost:8080",
    PXPIPE_MODELS: "off",
    PXPIPE_LOG: "/tmp/pxpipe.log",
    HOST: "0.0.0.0",
  });
});
