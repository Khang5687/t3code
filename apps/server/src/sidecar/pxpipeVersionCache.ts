import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";

/**
 * The pxpipe version cache is an exact `pxpipe-proxy@<version>` npm-installed
 * into <baseDir>/sidecars/pxpipe/<version>, beside `runtime`, `caches` and
 * `worktrees`. The supervisor spawns the installed bin, so the sidecar is
 * reproducible and starts offline after the first install. `npx --package`
 * was rejected for the same reason `npx t3` was: its cache belongs to npm,
 * not to T3 Code, and it offers no completion sentinel to trust.
 */
const PXPIPE_CACHE_DIR = ["sidecars", "pxpipe"] as const;
const PXPIPE_PACKAGE = "pxpipe-proxy";
const PXPIPE_INSTALL_TIMEOUT = Duration.minutes(5);
/** The version ADR 0004 pins this fork to. */
export const PINNED_PXPIPE_VERSION = "0.13.2";
// Settings changes and supervisor restarts can race. Serialize the complete
// install transaction, and removal with it, across every caller in this process.
const pxpipeCacheLock = Semaphore.makeUnsafe(1);

export interface PxpipeVersionPaths {
  readonly versionDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export function pxpipeVersionsDir(path: Path.Path, baseDir: string): string {
  return path.join(baseDir, ...PXPIPE_CACHE_DIR);
}

export function pxpipeVersionPaths(
  path: Path.Path,
  baseDir: string,
  version: string,
  platform: NodeJS.Platform,
): PxpipeVersionPaths {
  const versionDir = path.join(pxpipeVersionsDir(path, baseDir), version);
  return {
    versionDir,
    // npm writes a `.cmd` shim beside the POSIX shim on Windows, and that is
    // the one a spawn can run.
    entryPath: path.join(
      versionDir,
      "node_modules",
      ".bin",
      platform === "win32" ? "pxpipe.cmd" : "pxpipe",
    ),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PxpipeVersionCacheError extends Schema.TaggedErrorClass<PxpipeVersionCacheError>()(
  "PxpipeVersionCacheError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `pxpipe install failed while ${this.step}.`
      : `pxpipe install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export interface PxpipeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
}

/** What the supervisor spawns, and what it reports as the running version. */
export interface PxpipeBinary {
  readonly path: string;
  /**
   * Empty when a `binaryPath` override wins: T3 Code did not install that
   * binary and cannot claim a version for it.
   */
  readonly version: string;
}

/**
 * The entry point is what the supervisor runs, so a tree without it is
 * broken however complete it looks.
 */
const validateInstalled = Effect.fn("sidecar.pxpipe.validate")(function* (
  fs: FileSystem.FileSystem,
  paths: PxpipeVersionPaths,
) {
  const exists = yield* fs
    .exists(paths.entryPath)
    .pipe(
      Effect.mapError(
        (cause) => new PxpipeVersionCacheError({ step: "checking the pxpipe bin", cause }),
      ),
    );
  if (!exists) {
    return yield* new PxpipeVersionCacheError({ step: "finding the pxpipe bin after install" });
  }
});

/**
 * Installs `pxpipe-proxy@<version>` into the version cache unless a complete
 * install is already there, and returns its paths. The sentinel is written
 * only after npm exits 0 and the bin validates, and it is written inside the
 * staging directory: a killed install leaves a tree that never reads as
 * complete, and never lands at the published path at all.
 */
const installPxpipe = Effect.fn("sidecar.pxpipe.ensure_installed")(function* (
  input: PxpipeInstallInput,
) {
  const { fs, runner } = input;
  const paths = pxpipeVersionPaths(
    input.path,
    input.baseDir,
    input.version,
    yield* HostProcessPlatform,
  );
  const [versionDirExists, entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.versionDir),
    fs.exists(paths.entryPath),
    fs.readFileString(paths.sentinelPath).pipe(Effect.option),
  ]).pipe(
    Effect.mapError(
      (cause) => new PxpipeVersionCacheError({ step: "checking the pxpipe version cache", cause }),
    ),
  );
  if (entryExists && Option.isSome(sentinel) && sentinel.value.trim() === input.version) {
    return paths;
  }
  if (versionDirExists) {
    yield* fs
      .remove(paths.versionDir, { recursive: true, force: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PxpipeVersionCacheError({ step: "removing an incomplete pxpipe install", cause }),
        ),
      );
  }

  const versionsDir = input.path.dirname(paths.versionDir);
  const prepareStep = "preparing the pxpipe version cache directory";
  yield* fs
    .makeDirectory(versionsDir, { recursive: true })
    .pipe(Effect.mapError((cause) => new PxpipeVersionCacheError({ step: prepareStep, cause })));
  const stagingDir = yield* fs
    .makeTempDirectory({ directory: versionsDir, prefix: ".staging-" })
    .pipe(Effect.mapError((cause) => new PxpipeVersionCacheError({ step: prepareStep, cause })));
  const stagingPaths: PxpipeVersionPaths = {
    versionDir: stagingDir,
    entryPath: input.path.join(stagingDir, input.path.relative(paths.versionDir, paths.entryPath)),
    sentinelPath: input.path.join(stagingDir, ".install-complete"),
  };

  return yield* Effect.gen(function* () {
    const installStep = "installing pxpipe";
    const installArgs = [
      "install",
      "--prefix",
      stagingDir,
      "--no-fund",
      "--no-audit",
      `${PXPIPE_PACKAGE}@${input.version}`,
    ];
    yield* runner.run({ command: "npm", args: installArgs, timeout: PXPIPE_INSTALL_TIMEOUT }).pipe(
      Effect.catchTags({
        ProcessSpawnError: (error) =>
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? // pnpm-managed Node installations do not include npm.
              runner.run({
                command: "pnpm",
                args: ["--package=npm@11", "dlx", "npm", ...installArgs],
                timeout: PXPIPE_INSTALL_TIMEOUT,
              })
            : Effect.fail(error),
      }),
      Effect.mapError((cause) => new PxpipeVersionCacheError({ step: installStep, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new PxpipeVersionCacheError({
            step: installStep,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
    );

    yield* validateInstalled(fs, stagingPaths);
    yield* fs
      .writeFileString(stagingPaths.sentinelPath, `${input.version}\n`)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PxpipeVersionCacheError({ step: "recording the completed install", cause }),
        ),
      );
    yield* fs.rename(stagingDir, paths.versionDir).pipe(
      Effect.catch((cause) =>
        // Losing the rename race is fine as long as whoever won published this
        // same version and it validates.
        Effect.all([
          fs.exists(paths.entryPath),
          fs.readFileString(paths.sentinelPath).pipe(Effect.option),
        ]).pipe(
          Effect.mapError(
            (checkCause) =>
              new PxpipeVersionCacheError({
                step: "checking a concurrently published pxpipe install",
                cause: checkCause,
              }),
          ),
          Effect.flatMap(([publishedEntryExists, publishedSentinel]) =>
            publishedEntryExists &&
            Option.isSome(publishedSentinel) &&
            publishedSentinel.value.trim() === input.version
              ? Effect.void
              : Effect.fail(
                  new PxpipeVersionCacheError({ step: "publishing the pxpipe install", cause }),
                ),
          ),
        ),
      ),
    );
    return paths;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const ensurePxpipeInstalled = (input: PxpipeInstallInput) =>
  pxpipeCacheLock.withPermit(installPxpipe(input));

/**
 * Resolves what to spawn. A `binaryPath` override bypasses the cache
 * entirely: the user pointed at their own pxpipe, so nothing is installed.
 */
export const resolvePxpipeBinary = Effect.fn("sidecar.pxpipe.resolve_binary")(function* (
  input: PxpipeInstallInput & { readonly binaryPath?: string | undefined },
): Effect.fn.Return<PxpipeBinary, PxpipeVersionCacheError> {
  const override = input.binaryPath?.trim() ?? "";
  if (override !== "") return { path: override, version: "" };
  const paths = yield* ensurePxpipeInstalled(input);
  return { path: paths.entryPath, version: input.version };
});

interface PxpipeRemoveInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * Deletes a cached version and reports whether anything was there. Refusing
 * to remove a version that is running belongs to the supervisor, which is the
 * only thing that knows.
 */
const removeVersion = Effect.fn("sidecar.pxpipe.remove_version")(
  function* (input: PxpipeRemoveInput) {
    const { versionDir } = pxpipeVersionPaths(
      input.path,
      input.baseDir,
      input.version,
      yield* HostProcessPlatform,
    );
    const existed = yield* input.fs.exists(versionDir);
    if (existed) yield* input.fs.remove(versionDir, { recursive: true, force: true });
    return { removed: existed, versionDir };
  },
  Effect.mapError(
    (cause) => new PxpipeVersionCacheError({ step: "removing a cached pxpipe version", cause }),
  ),
);

export const removePxpipeVersion = (input: PxpipeRemoveInput) =>
  pxpipeCacheLock.withPermit(removeVersion(input));
