import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";
import {
  pxpipeVersionPaths,
  pxpipeVersionsDir,
  removePxpipeVersion,
  resolvePxpipeBinary,
} from "./pxpipeVersionCache.ts";

const VERSION = "0.13.2";

const exitOk = {
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
} as const;

const PLATFORM = HostProcessPlatform.defaultValue();

const versionPaths = (path: Path.Path, baseDir: string) =>
  pxpipeVersionPaths(path, baseDir, VERSION, PLATFORM);

/** Stands in for npm: writes the bin the real install would leave behind. */
const successfulRunner = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  onInstall: (stagingDir: string) => Effect.Effect<void> = () => Effect.void,
) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        const stagingDir = input.args[input.args.indexOf("--prefix") + 1];
        if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
        const entry = path.basename(versionPaths(path, "/base").entryPath);
        const entryPath = path.join(stagingDir, "node_modules", ".bin", entry);
        yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(entryPath, "#!/bin/sh\n").pipe(Effect.orDie);
        yield* onInstall(stagingDir);
        return exitOk;
      }),
  });

it.layer(NodeServices.layer)("pxpipe version cache", (it) => {
  it.effect("publishes a fresh install with its sentinel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-install-" });
      const paths = versionPaths(path, baseDir);

      let publishedDuringInstall = true;
      let installedInto = "";
      const binary = yield* resolvePxpipeBinary({
        baseDir,
        version: VERSION,
        fs,
        path,
        runner: successfulRunner(fs, path, (stagingDir) =>
          // Nothing is visible at the published path until the rename lands.
          Effect.gen(function* () {
            installedInto = stagingDir;
            publishedDuringInstall = yield* fs.exists(paths.versionDir);
          }).pipe(Effect.orDie),
        ),
      });

      assert.isFalse(publishedDuringInstall);
      assert.notEqual(installedInto, paths.versionDir);
      assert.deepEqual(binary, { path: paths.entryPath, version: VERSION });
      assert.equal(yield* fs.readFileString(paths.sentinelPath), `${VERSION}\n`);
      assert.deepEqual(
        (yield* fs.readDirectory(pxpipeVersionsDir(path, baseDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("rebuilds a tree whose install never completed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-rebuild-" });
      const paths = versionPaths(path, baseDir);
      yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "half-written\n");

      let installs = 0;
      yield* resolvePxpipeBinary({
        baseDir,
        version: VERSION,
        fs,
        path,
        runner: successfulRunner(fs, path, () => Effect.sync(() => void installs++)),
      });

      assert.equal(installs, 1);
      assert.equal(yield* fs.readFileString(paths.entryPath), "#!/bin/sh\n");
      assert.equal(yield* fs.readFileString(paths.sentinelPath), `${VERSION}\n`);
    }),
  );

  it.effect("reuses a complete install without running an installer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-cached-" });
      const paths = versionPaths(path, baseDir);
      yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "#!/bin/sh\n");
      yield* fs.writeFileString(paths.sentinelPath, `${VERSION}\n`);

      const binary = yield* resolvePxpipeBinary({
        baseDir,
        version: VERSION,
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({ run: () => Effect.die("must not install") }),
      });

      assert.equal(binary.path, paths.entryPath);
    }),
  );

  it.effect("accepts losing the publish race to another process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-race-" });
      const paths = versionPaths(path, baseDir);

      const binary = yield* resolvePxpipeBinary({
        baseDir,
        version: VERSION,
        fs,
        path,
        // Another process publishes the same version while this install runs,
        // so the rename below lands on a directory that already exists.
        runner: successfulRunner(fs, path, () =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(paths.entryPath), { recursive: true });
            yield* fs.writeFileString(paths.entryPath, "published elsewhere\n");
            yield* fs.writeFileString(paths.sentinelPath, `${VERSION}\n`);
          }).pipe(Effect.orDie),
        ),
      });

      assert.equal(binary.path, paths.entryPath);
      assert.equal(yield* fs.readFileString(paths.entryPath), "published elsewhere\n");
      assert.deepEqual(
        (yield* fs.readDirectory(pxpipeVersionsDir(path, baseDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("leaves nothing behind when the installer fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-failed-" });
      const paths = versionPaths(path, baseDir);

      const error = yield* resolvePxpipeBinary({
        baseDir,
        version: VERSION,
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({
          run: () => Effect.succeed({ ...exitOk, code: ChildProcessSpawner.ExitCode(1) }),
        }),
      }).pipe(Effect.flip);

      assert.equal(error.exitCode, 1);
      assert.isFalse(yield* fs.exists(paths.versionDir));
      assert.deepEqual(yield* fs.readDirectory(pxpipeVersionsDir(path, baseDir)), []);
    }),
  );

  it.effect("leaves nothing behind when the install is killed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-interrupt-" });
      const started = yield* Deferred.make<void>();
      const install = yield* resolvePxpipeBinary({
        baseDir,
        version: VERSION,
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({
          run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(install);
      assert.deepEqual(yield* fs.readDirectory(pxpipeVersionsDir(path, baseDir)), []);
    }),
  );

  it.effect("falls back to pnpm when the Node runtime has no npm", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-pnpm-" });
      const commands: Array<ProcessRunner.ProcessRunInput> = [];
      const install = successfulRunner(fs, path);

      yield* resolvePxpipeBinary({
        baseDir,
        version: VERSION,
        fs,
        path,
        runner: ProcessRunner.ProcessRunner.of({
          run: (input) => {
            commands.push(input);
            return input.command === "npm"
              ? Effect.fail(
                  new ProcessRunner.ProcessSpawnError({
                    command: "npm",
                    argumentCount: input.args.length,
                    cause: PlatformError.systemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                    }),
                  }),
                )
              : install.run(input);
          },
        }),
      });

      assert.deepEqual(
        commands.map((command) => command.command),
        ["npm", "pnpm"],
      );
      assert.deepEqual(commands[1]!.args, ["--package=npm@11", "dlx", "npm", ...commands[0]!.args]);
      assert.include(commands[0]!.args, `pxpipe-proxy@${VERSION}`);
    }),
  );

  it.effect("spawns a configured binaryPath without touching the cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-override-" });

      const binary = yield* resolvePxpipeBinary({
        baseDir,
        version: VERSION,
        fs,
        path,
        binaryPath: "  /opt/pxpipe/bin/pxpipe  ",
        runner: ProcessRunner.ProcessRunner.of({ run: () => Effect.die("must not install") }),
      });

      assert.deepEqual(binary, { path: "/opt/pxpipe/bin/pxpipe", version: "" });
      assert.isFalse(yield* fs.exists(pxpipeVersionsDir(path, baseDir)));
    }),
  );

  it.effect("removes a cached version and reports whether one was there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pxpipe-remove-" });
      const paths = versionPaths(path, baseDir);
      yield* resolvePxpipeBinary({
        baseDir,
        version: VERSION,
        fs,
        path,
        runner: successfulRunner(fs, path),
      });

      const removed = yield* removePxpipeVersion({ baseDir, version: VERSION, fs, path });
      assert.deepEqual(removed, { removed: true, versionDir: paths.versionDir });
      assert.isFalse(yield* fs.exists(paths.versionDir));

      const again = yield* removePxpipeVersion({ baseDir, version: VERSION, fs, path });
      assert.isFalse(again.removed);
    }),
  );
});
