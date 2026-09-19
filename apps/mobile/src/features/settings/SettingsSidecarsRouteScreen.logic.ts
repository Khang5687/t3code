/**
 * Fork-only (ADR 0004). What Settings → pxpipe shows and writes.
 *
 * Mobile reads pxpipe, it does not run it: no start, stop, port, or cache
 * controls live here. The one thing it can change is per-instance routing,
 * which is the only pxpipe setting a user wants to flip from a phone.
 */
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderDriverKind as ProviderDriverKindType,
  type ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
  type SidecarEnvironmentVariable,
} from "@t3tools/contracts";
import {
  claudeFirstPartyFeaturesStatus,
  readFirstPartyRemoteFeatures,
} from "@t3tools/client-runtime/state/claude-first-party";
import {
  pxpipeRoutingOverride,
  readRouteThroughPxpipe,
} from "@t3tools/client-runtime/state/pxpipe";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

export interface PxpipeRoutableInstance {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly routed: boolean;
  /** Set when the switch is on but a hand-set base URL wins; null otherwise. */
  readonly inactiveReason: string | null;
  /**
   * Read-only echo of the instance's first-party gates. Mobile has no provider
   * settings screen to flip them from, and this is the only place it lists
   * Claude instances — so it reports what routing already implies rather than
   * leaving the phone unable to see it at all.
   */
  readonly remoteFeaturesStatus: string;
}

/**
 * Whether turns on this instance go through the sidecar.
 *
 * Mirrors the server's own rule (`instanceRoutesThroughPxpipe`): an explicit
 * `providerInstances` entry wins, otherwise the legacy `providers.claudeAgent`
 * mirror answers for the default instance id. Getting this wrong would draw a
 * switch that disagrees with what the next turn does.
 */
function instanceRouted(settings: ServerSettings, instanceId: ProviderInstanceId): boolean {
  const entry = settings.providerInstances[instanceId];
  if (entry !== undefined) {
    return entry.driver === CLAUDE_DRIVER_KIND && readRouteThroughPxpipe(entry.config);
  }
  return (
    instanceId === defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND) &&
    settings.providers.claudeAgent.routeThroughPxpipe
  );
}

/**
 * The Claude instances this environment can route, in the order the server
 * reported them. Driven by the provider snapshot rather than settings so the
 * default slot appears whether or not it has been written to
 * `providerInstances` yet, and so an instance whose driver this build cannot
 * load is not offered a switch that would do nothing.
 */
export function pxpipeRoutableInstances(
  providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKindType;
    readonly displayName?: string | undefined;
    readonly claudeManagedSettings?: boolean | undefined;
  }>,
  settings: ServerSettings,
): ReadonlyArray<PxpipeRoutableInstance> {
  return providers
    .filter((provider) => provider.driver === CLAUDE_DRIVER_KIND)
    .map((provider) => {
      const routed = instanceRouted(settings, provider.instanceId);
      // Only an explicit entry carries an environment; the legacy default slot
      // has nowhere to hold one. An inherited ANTHROPIC_BASE_URL on the server
      // process also wins, and no client can see that.
      const environment: ReadonlyArray<SidecarEnvironmentVariable> | undefined =
        settings.providerInstances[provider.instanceId]?.environment;
      const inactiveReason = pxpipeRoutingOverride(routed, environment);
      return {
        instanceId: provider.instanceId,
        label:
          provider.displayName ??
          PROVIDER_DISPLAY_NAMES[provider.driver] ??
          String(provider.instanceId),
        routed,
        inactiveReason,
        remoteFeaturesStatus: claudeFirstPartyFeaturesStatus({
          allowed: readFirstPartyRemoteFeatures(
            settings.providerInstances[provider.instanceId]?.config ??
              settings.providers.claudeAgent,
          ),
          // The switch alone is not routing; an overridden base URL means this
          // instance gets none of what routing would close.
          routedThroughPxpipe: routed && inactiveReason === null,
          managedSettingsPresent: provider.claudeManagedSettings,
        }),
      };
    });
}

/**
 * The settings patch that turns routing on or off for one instance.
 *
 * Two shapes because settings has two: `providerInstances` takes a whole-map
 * replacement (partial entry patches are out of scope by contract), while the
 * unwritten default slot is cheaper and safer to patch through its legacy
 * `providers.claudeAgent` mirror than to materialise as an instance envelope
 * from a phone.
 */
export function pxpipeRoutingPatch(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
  routed: boolean,
): ServerSettingsPatch | null {
  const entry = settings.providerInstances[instanceId];
  if (entry !== undefined) {
    if (entry.driver !== CLAUDE_DRIVER_KIND) return null;
    const config = entry.config;
    return {
      providerInstances: {
        ...settings.providerInstances,
        [instanceId]: {
          ...entry,
          config: {
            ...(config !== null && typeof config === "object" ? config : {}),
            routeThroughPxpipe: routed,
          },
        },
      },
    };
  }
  if (instanceId !== defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND)) return null;
  return { providers: { claudeAgent: { routeThroughPxpipe: routed } } };
}
