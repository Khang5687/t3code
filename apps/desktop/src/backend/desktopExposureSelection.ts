import {
  exposurePresetOf,
  formatListenHostSelection,
  legacyExposureModeOf,
  listenInterfacesForPreset,
  normalizeListenInterfaces,
  type ExposurePreset,
  type LegacyExposureMode,
  type ListenInterfaces,
  type ListenInterfacesInput,
} from "@t3tools/contracts";
import {
  isTailscaleIpv4Address,
  resolveListenAddresses,
  LOOPBACK_LISTEN_ADDRESS,
  type NetworkInterfaceMap,
} from "@t3tools/tailscale";

import type { NetworkInterfaces } from "./DesktopNetworkInterfaces.ts";

/**
 * `os.networkInterfaces()` reports IPv4 `family` as the string "IPv4" on the
 * Node build Electron ships, but some builds report the numeric 4. The shared
 * resolver matches the string, so normalize before handing interfaces over.
 */
const toResolverInterfaces = (interfaces: NetworkInterfaces): NetworkInterfaceMap =>
  Object.fromEntries(
    Object.entries(interfaces).map(([name, entries]) => [
      name,
      entries?.map((entry) => ({
        address: entry.address,
        family: String(entry.family) === "4" ? "IPv4" : String(entry.family),
        internal: entry.internal,
      })),
    ]),
  );

const normalizeOptionalHost = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

export interface DesktopExposureResolution {
  /** The selection as asked for. This is what the bootstrap envelope carries. */
  readonly requested: ListenInterfaces;
  readonly preset: ExposurePreset;
  /** Derived from the *effective* selection, so a request that resolved to nothing reads local-only. */
  readonly mode: LegacyExposureMode;
  /** `--host` spelling of `requested`; never a resolved IP and never a wildcard. */
  readonly listenHost: string;
  readonly resolvedAddresses: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  /** Hosts the desktop-core endpoints advertise, in bind order. */
  readonly advertisedHosts: ReadonlyArray<string>;
  readonly tailnetSelected: boolean;
  /** The request needed more than loopback and got nothing else. */
  readonly unavailable: boolean;
}

/**
 * Reads a listen-interface selection against the machine's interfaces for
 * display and endpoint purposes (ADR 0003). The server resolves the same
 * selection again at launch and stays authoritative over what is bound.
 */
export const resolveDesktopExposure = (input: {
  readonly requested: ListenInterfacesInput;
  readonly networkInterfaces: NetworkInterfaces;
  readonly advertisedHostOverride?: string;
}): DesktopExposureResolution => {
  const requested = normalizeListenInterfaces(input.requested);
  const resolved = resolveListenAddresses(requested, toResolverInterfaces(input.networkInterfaces));
  const tailnetSelected = requested.kinds.includes("tailnet");

  // Asked for more than loopback and got nothing else: report local-only while
  // leaving the request in settings, so the preference survives the interface
  // coming back. The backend would bind loopback either way.
  const askedForMoreThanLoopback = requested.kinds.length > 1 || requested.addresses.length > 0;
  const unavailable =
    askedForMoreThanLoopback &&
    resolved.addresses.every((address) => address === LOOPBACK_LISTEN_ADDRESS);
  const effective = unavailable ? listenInterfacesForPreset("local-only") : requested;

  const override = normalizeOptionalHost(input.advertisedHostOverride);
  const advertisedHosts = unavailable
    ? []
    : override
      ? [override]
      : resolved.addresses.filter(
          (address) =>
            address !== LOOPBACK_LISTEN_ADDRESS &&
            // Tailnet addresses belong to the Tailscale endpoint provider, so
            // core only claims one when the selection named it explicitly.
            !(tailnetSelected && isTailscaleIpv4Address(address)),
        );

  return {
    requested,
    preset: exposurePresetOf(requested),
    mode: legacyExposureModeOf(effective),
    listenHost: formatListenHostSelection(requested),
    resolvedAddresses: resolved.addresses,
    warnings: resolved.warnings,
    advertisedHosts,
    tailnetSelected,
    unavailable,
  };
};
