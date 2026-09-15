import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "@t3tools/shared/advertisedEndpoint";
import {
  DesktopServerExposureModeSchema,
  listenInterfacesForLegacyExposureMode,
  type AdvertisedEndpoint,
  type AdvertisedEndpointProvider,
  type DesktopServerExposureMode,
  type DesktopServerExposureState,
  type ListenInterfacesInput,
} from "@t3tools/contracts";
import { readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import {
  resolveDesktopExposure,
  type DesktopExposureResolution,
} from "./desktopExposureSelection.ts";
import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";

const TAILSCALE_STATUS_CACHE_TTL = Duration.seconds(60);

export const DESKTOP_LOOPBACK_HOST = "127.0.0.1";

const DESKTOP_CORE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
};

const DESKTOP_MANUAL_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "manual",
  label: "Manual",
  kind: "manual",
  isAddon: false,
};

const isHttpsEndpointUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const createDesktopEndpoint = (
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_CORE_ENDPOINT_PROVIDER,
    source: "desktop-core",
  });

const createManualEndpoint = (
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_MANUAL_ENDPOINT_PROVIDER,
    source: "user",
  });

const resolveDesktopCoreAdvertisedEndpoints = (input: {
  readonly port: number;
  readonly localHttpUrl: string;
  readonly advertisedHosts: ReadonlyArray<string>;
  readonly customHttpsEndpointUrls?: readonly string[];
}): readonly AdvertisedEndpoint[] => {
  const endpoints: AdvertisedEndpoint[] = [
    createDesktopEndpoint({
      id: `desktop-loopback:${input.port}`,
      label: "This machine",
      httpBaseUrl: input.localHttpUrl,
      reachability: "loopback",
      status: "available",
      description: "Loopback endpoint for this desktop app.",
    }),
  ];

  // One endpoint per address the selection resolved to. Only the first is the
  // default; the rest are alternate routes to the same backend.
  input.advertisedHosts.forEach((host, index) => {
    const endpointUrl = `http://${host}:${input.port}`;
    endpoints.push(
      createDesktopEndpoint({
        id: `desktop-lan:${endpointUrl}`,
        label: "Local network",
        httpBaseUrl: endpointUrl,
        reachability: "lan",
        status: "available",
        ...(index === 0 ? { isDefault: true } : {}),
        description: "Reachable from devices on the same network.",
      }),
    );
  });

  for (const customEndpointUrl of input.customHttpsEndpointUrls ?? []) {
    try {
      const isHttpsEndpoint = isHttpsEndpointUrl(customEndpointUrl);
      endpoints.push(
        createManualEndpoint({
          id: `manual:${customEndpointUrl}`,
          label: isHttpsEndpoint ? "Custom HTTPS" : "Custom endpoint",
          httpBaseUrl: customEndpointUrl,
          reachability: "public",
          ...(isHttpsEndpoint ? ({ hostedHttpsCompatibility: "compatible" } as const) : {}),
          status: "unknown",
          description: isHttpsEndpoint
            ? "User-configured HTTPS endpoint for this desktop backend."
            : "User-configured endpoint for this desktop backend.",
        }),
      );
    } catch {
      // Ignore malformed user-configured endpoints without dropping valid endpoints.
    }
  }

  return endpoints;
};

export class DesktopServerExposureNoNetworkAddressError extends Schema.TaggedErrorClass<DesktopServerExposureNoNetworkAddressError>()(
  "DesktopServerExposureNoNetworkAddressError",
  {
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `No reachable network address is available for desktop network access on port ${this.port}.`;
  }
}

export class DesktopServerExposureModePersistenceError extends Schema.TaggedErrorClass<DesktopServerExposureModePersistenceError>()(
  "DesktopServerExposureModePersistenceError",
  {
    mode: DesktopServerExposureModeSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist desktop server exposure mode ${this.mode}.`;
  }
}

export class DesktopTailscaleServePersistenceError extends Schema.TaggedErrorClass<DesktopTailscaleServePersistenceError>()(
  "DesktopTailscaleServePersistenceError",
  {
    enabled: Schema.Boolean,
    port: Schema.NullOr(Schema.Number),
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist desktop Tailscale Serve settings (enabled: ${this.enabled}, port: ${this.port ?? "unchanged"}).`;
  }
}

export const DesktopServerExposureSetModeError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
]);
export type DesktopServerExposureSetModeError = typeof DesktopServerExposureSetModeError.Type;

export const DesktopServerExposureError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
  DesktopTailscaleServePersistenceError,
]);
export type DesktopServerExposureError = typeof DesktopServerExposureError.Type;

export interface DesktopServerExposureBackendConfig {
  readonly port: number;
  /**
   * The listen-interface selection in `--host` form. The backend resolves it;
   * the desktop never sends a pre-resolved address or a wildcard (ADR 0003).
   */
  readonly listenHost: string;
  readonly httpBaseUrl: URL;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
}

export interface DesktopServerExposureChange {
  readonly state: DesktopServerExposureState;
  readonly requiresRelaunch: boolean;
}

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  {
    readonly getState: Effect.Effect<DesktopServerExposureState>;
    readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
    readonly configureFromSettings: (input: {
      readonly port: number;
    }) => Effect.Effect<DesktopServerExposureState>;
    readonly setListenInterfaces: (
      listenInterfaces: ListenInterfacesInput,
    ) => Effect.Effect<DesktopServerExposureChange, DesktopServerExposureSetModeError>;
    readonly setMode: (
      mode: DesktopServerExposureMode,
    ) => Effect.Effect<DesktopServerExposureChange, DesktopServerExposureSetModeError>;
    readonly setTailscaleServeEnabled: (input: {
      readonly enabled: boolean;
      readonly port?: number;
    }) => Effect.Effect<DesktopServerExposureChange, DesktopTailscaleServePersistenceError>;
    readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
  }
>()("@t3tools/desktop/backend/DesktopServerExposure") {}

interface RuntimeState {
  readonly resolution: DesktopExposureResolution;
  readonly port: number;
  readonly localHttpUrl: string;
  readonly httpBaseUrl: URL;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
}

function makeRuntimeState(input: {
  readonly requested: ListenInterfacesInput;
  readonly settings: DesktopAppSettings.DesktopSettings;
  readonly port: number;
  readonly networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly advertisedHostOverride: Option.Option<string>;
}): RuntimeState {
  const localHttpUrl = `http://${DESKTOP_LOOPBACK_HOST}:${input.port}`;
  const advertisedHostOverride = Option.getOrUndefined(input.advertisedHostOverride);
  const resolution = resolveDesktopExposure({
    requested: input.requested,
    networkInterfaces: input.networkInterfaces,
    ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
  });

  return {
    resolution,
    port: input.port,
    localHttpUrl,
    httpBaseUrl: new URL(localHttpUrl),
    tailscaleServeEnabled: input.settings.tailscaleServeEnabled,
    tailscaleServePort: input.settings.tailscaleServePort,
  };
}

const initialRuntimeState = (): RuntimeState =>
  makeRuntimeState({
    requested: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.listenInterfaces,
    settings: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
    port: 0,
    networkInterfaces: {},
    advertisedHostOverride: Option.none(),
  });

const advertisedHostOf = (state: RuntimeState): string | null =>
  state.resolution.advertisedHosts[0] ?? null;

const toContractState = (state: RuntimeState): DesktopServerExposureState => {
  const advertisedHost = advertisedHostOf(state);
  return {
    mode: state.resolution.mode,
    listenInterfaces: state.resolution.requested,
    preset: state.resolution.preset,
    resolvedAddresses: state.resolution.resolvedAddresses,
    warnings: state.resolution.warnings,
    tailscaleServeAvailable: state.resolution.tailnetResolved,
    endpointUrl: advertisedHost ? `http://${advertisedHost}:${state.port}` : null,
    advertisedHost,
    tailscaleServeEnabled: state.tailscaleServeEnabled,
    tailscaleServePort: state.tailscaleServePort,
  };
};

const toBackendConfig = (state: RuntimeState): DesktopServerExposureBackendConfig => ({
  port: state.port,
  listenHost: state.resolution.listenHost,
  httpBaseUrl: state.httpBaseUrl,
  // Serve has nothing to serve unless a tailnet address actually resolved.
  tailscaleServeEnabled: state.tailscaleServeEnabled && state.resolution.tailnetResolved,
  tailscaleServePort: state.tailscaleServePort,
});

/** Exposure is bind-time state: the selection only takes effect on a fresh backend. */
const requiresBackendRelaunch = (previous: RuntimeState, next: RuntimeState): boolean =>
  previous.port !== next.port ||
  previous.resolution.listenHost !== next.resolution.listenHost ||
  previous.localHttpUrl !== next.localHttpUrl;

export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const networkInterfaces = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const stateRef = yield* Ref.make(initialRuntimeState());

  // Cache the `tailscale status` spawn for the TTL. On macOS, the Mac App
  // Store Tailscale CLI lives inside Tailscale's sandbox container, so each
  // spawn re-triggers the "Other apps" TCC prompt.
  const cachedReadMagicDnsName = yield* Effect.cachedWithTTL(
    readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    ),
    TAILSCALE_STATUS_CACHE_TTL,
  );

  const readNetworkInterfaces = networkInterfaces.read;

  const getState = Ref.get(stateRef).pipe(Effect.map(toContractState));
  const backendConfig = Ref.get(stateRef).pipe(Effect.map(toBackendConfig));

  const configureFromSettings = Effect.fn("desktop.serverExposure.configureFromSettings")(
    function* ({ port }: { readonly port: number }) {
      yield* Effect.annotateCurrentSpan({ port });
      const settings = yield* desktopSettings.get;
      const currentNetworkInterfaces = yield* readNetworkInterfaces;
      const next = makeRuntimeState({
        requested: settings.listenInterfaces,
        settings,
        port,
        networkInterfaces: currentNetworkInterfaces,
        advertisedHostOverride: config.desktopLanHostOverride,
      });
      yield* Ref.set(stateRef, next);
      return toContractState(next);
    },
  );

  const setListenInterfaces = Effect.fn("desktop.serverExposure.setListenInterfaces")(function* (
    requested: ListenInterfacesInput,
  ) {
    const previous = yield* Ref.get(stateRef);
    const currentSettings = yield* desktopSettings.get;
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const next = makeRuntimeState({
      requested,
      settings: currentSettings,
      port: previous.port,
      networkInterfaces: currentNetworkInterfaces,
      advertisedHostOverride: config.desktopLanHostOverride,
    });
    yield* Effect.annotateCurrentSpan({ listenHost: next.resolution.listenHost });

    if (next.resolution.unavailable) {
      return yield* new DesktopServerExposureNoNetworkAddressError({ port: previous.port });
    }

    const change = yield* desktopSettings.setListenInterfaces(next.resolution.requested).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopServerExposureModePersistenceError({
            mode: next.resolution.mode,
            cause,
          }),
      ),
    );

    yield* Ref.set(stateRef, next);
    return {
      state: toContractState(next),
      requiresRelaunch: change.changed || requiresBackendRelaunch(previous, next),
    };
  });

  const setMode = Effect.fn("desktop.serverExposure.setMode")(function* (
    mode: DesktopServerExposureMode,
  ) {
    yield* Effect.annotateCurrentSpan({ mode });
    return yield* setListenInterfaces(listenInterfacesForLegacyExposureMode(mode));
  });

  const setTailscaleServeEnabled = Effect.fn("desktop.serverExposure.setTailscaleServeEnabled")(
    function* (input: { readonly enabled: boolean; readonly port?: number }) {
      yield* Effect.annotateCurrentSpan({
        enabled: input.enabled,
        ...(input.port === undefined ? {} : { port: input.port }),
      });
      const result = yield* desktopSettings
        .setTailscaleServe({
          enabled: input.enabled,
          port: Option.fromNullishOr(input.port),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DesktopTailscaleServePersistenceError({
                enabled: input.enabled,
                port: input.port ?? null,
                cause,
              }),
          ),
        );

      const nextState = yield* Ref.updateAndGet(stateRef, (current) => ({
        ...current,
        tailscaleServeEnabled: result.settings.tailscaleServeEnabled,
        tailscaleServePort: result.settings.tailscaleServePort,
      }));

      return {
        state: toContractState(nextState),
        requiresRelaunch: result.changed,
      };
    },
  );

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
      port: state.port,
      localHttpUrl: state.localHttpUrl,
      advertisedHosts: state.resolution.advertisedHosts,
      customHttpsEndpointUrls: config.desktopHttpsEndpointUrls,
    });

    // Tailnet endpoints and Tailscale Serve exist only once a tailnet address
    // has resolved. Skipping the spawn also avoids the macOS "Other apps" TCC
    // prompt that Mac App Store Tailscale builds raise on every invocation.
    if (!state.resolution.tailnetResolved) {
      return coreEndpoints;
    }

    const tailscaleEndpoints = yield* resolveTailscaleAdvertisedEndpoints({
      port: state.port,
      serveEnabled: state.tailscaleServeEnabled,
      servePort: state.tailscaleServePort,
      networkInterfaces: currentNetworkInterfaces,
      readMagicDnsName: cachedReadMagicDnsName,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return [...coreEndpoints, ...tailscaleEndpoints];
  }).pipe(Effect.withSpan("desktop.serverExposure.getAdvertisedEndpoints"));

  return DesktopServerExposure.of({
    getState,
    backendConfig,
    configureFromSettings,
    setListenInterfaces,
    setMode,
    setTailscaleServeEnabled,
    getAdvertisedEndpoints,
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);
