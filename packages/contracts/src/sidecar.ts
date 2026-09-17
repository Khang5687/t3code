/**
 * Sidecar contracts (fork-only, ADR 0004). A sidecar is a helper process the
 * environment starts, supervises, and stops alongside its server. Today the
 * only one is pxpipe, a local HTTP proxy serving the Anthropic Messages API.
 *
 * Its own file for the same reason `exposure.ts` is: one concern, and
 * `settings.ts` already imports enough.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ProviderInstanceEnvironmentVariable } from "./providerInstance.ts";

/**
 * What the supervisor reports about a sidecar process.
 *
 * `disabled` and `stopped` are different answers: `disabled` means settings
 * say not to run it, `stopped` means it is configured to run and a client
 * stopped it. `failed` means the supervisor gave up after capped backoff, so
 * only an explicit start brings it back.
 */
export const SidecarStatus = Schema.Literals([
  "disabled",
  "stopped",
  "starting",
  "healthy",
  "unhealthy",
  "failed",
]);
export type SidecarStatus = typeof SidecarStatus.Type;

/**
 * Same shape as a provider instance's environment variable, deliberately the
 * same schema: `sensitive` entries round-trip through `ServerSecretStore` with
 * the helpers that already exist for provider environments.
 */
export const SidecarEnvironmentVariable = ProviderInstanceEnvironmentVariable;
export type SidecarEnvironmentVariable = typeof SidecarEnvironmentVariable.Type;

/** pxpipe's own default, which it reads from `PORT`. */
export const DEFAULT_PXPIPE_SIDECAR_PORT = 47821;

/**
 * Shared by the settings struct and its patch so an out-of-range port fails
 * the one update that introduced it rather than a later whole-settings read.
 */
export const PxpipeSidecarPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
export type PxpipeSidecarPort = typeof PxpipeSidecarPort.Type;

/**
 * pxpipe takes environment variables only; it has no argv flags. The typed
 * core maps onto `PORT`, `PXPIPE_MODELS`, `PXPIPE_LOG` and
 * `ANTHROPIC_UPSTREAM`. `HOST` is deliberately untyped and rides `extraEnv`:
 * binding a non-loopback interface is a non-goal of ADR 0004, so it is not a
 * first-class control.
 */
export const PxpipeSidecarSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.annotateKey({
      title: "Run the pxpipe sidecar",
      description: "Start pxpipe with this environment's server and supervise it.",
    }),
  ),
  port: PxpipeSidecarPort.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PXPIPE_SIDECAR_PORT)),
    Schema.annotateKey({
      title: "Port",
      description: "Loopback port pxpipe listens on.",
    }),
  ),
  models: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
    Schema.annotateKey({
      title: "Imaging models",
      description:
        'Models pxpipe renders images for. Empty keeps pxpipe\'s own default; ["off"] runs the proxy with imaging disabled. There is no separate disable field: turning `enabled` off stops the process.',
    }),
  ),
  logPath: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Log path",
      description: "Where pxpipe writes its log. Empty leaves pxpipe's default.",
    }),
  ),
  binaryPath: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Binary path",
      description:
        "Override the pinned binary from T3's version cache with one on this machine. Empty uses the managed install.",
    }),
  ),
  anthropicUpstream: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Anthropic upstream",
      description:
        "Where pxpipe forwards requests. Empty uses https://api.anthropic.com. Overrides PXPIPE_UPSTREAM.",
    }),
  ),
  extraEnv: Schema.Array(SidecarEnvironmentVariable).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
    Schema.annotateKey({
      title: "Extra environment",
      description:
        "Environment variables passed to pxpipe verbatim, for knobs without a typed control. Entries marked sensitive are stored outside settings.json.",
    }),
  ),
});
export type PxpipeSidecarSettings = typeof PxpipeSidecarSettings.Type;

/** What the supervisor knows about the pxpipe process right now. */
export const PxpipeSidecarState = Schema.Struct({
  status: SidecarStatus,
  /**
   * The port the running process bound, which is the configured port except
   * between a settings change and the restart that picks it up.
   */
  port: PxpipeSidecarPort,
  /** The pinned version this environment runs, empty before the first install. */
  version: TrimmedString,
  pid: Schema.NullOr(PositiveInt),
  /**
   * A pxpipe the user started themselves, found answering on the configured
   * port. It is used, never supervised, and never killed, so it reports no
   * pid and no version. Defaulted so a state written before adoption existed
   * still decodes.
   */
  adopted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Supervised restarts since the sidecar was last healthy. */
  restartCount: NonNegativeInt,
  /** Why the last start or health check failed; null while healthy. */
  lastError: Schema.NullOr(TrimmedNonEmptyString),
});
export type PxpipeSidecarState = typeof PxpipeSidecarState.Type;

/**
 * pxpipe's `GET /proxy-stats` body, kept as an open record on purpose: it is a
 * flat JSON object of around 35 keys owned by another project, and a patch
 * release that adds, renames or retypes one must not fail the decode and blank
 * the card. Settings → Sidecars → pxpipe renders `requests`,
 * `compressed_requests`, `saved_pct`, `saved_usd`, `uptime_sec`,
 * `compression_enabled` and the nested `render_cache`, narrowing each itself.
 */
export const PxpipeProxyStats = Schema.Record(Schema.String, Schema.Unknown);
export type PxpipeProxyStats = typeof PxpipeProxyStats.Type;

/**
 * A sidecar operation the server refused or could not finish — removing a
 * cached version while the process is running, or a cache that would not
 * delete. It carries a sentence the page can show as-is, because the reason is
 * the whole point of the failure.
 */
export class SidecarOperationError extends Schema.TaggedErrorClass<SidecarOperationError>()(
  "SidecarOperationError",
  {
    message: Schema.String,
  },
) {}
