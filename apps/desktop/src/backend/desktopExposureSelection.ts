import {
  exposurePresetOf,
  formatListenInterfaces,
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
} from "@t3tools/tailscale";

import type { NetworkInterfaces } from "./DesktopNetworkInterfaces.ts";

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
  readonly listenSelection: string;
  readonly resolvedAddresses: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  /** Hosts the desktop-core endpoints advertise, in bind order. */
  readonly advertisedHosts: ReadonlyArray<string>;
  readonly tailnetSelected: boolean;
  /** The tailnet was selected *and* an address for it resolved. */
  readonly tailnetResolved: boolean;
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
  const resolved = resolveListenAddresses(requested, input.networkInterfaces);
  const tailnetSelected = requested.kinds.includes("tailnet");
  // Serve and the tailnet endpoints need a real tailnet address, not just the
  // kind. The `lan` preset carries `tailnet`, so gating on the kind alone would
  // spawn the Tailscale CLI on every LAN machine without Tailscale installed,
  // raising the macOS "Other apps" TCC prompt for nothing.
  const tailnetResolved = tailnetSelected && resolved.addresses.some(isTailscaleIpv4Address);

  // The resolver owns the fallback policy, so read its verdict rather than
  // taking a second reading here. Report local-only while leaving the request
  // in settings, so the preference survives the interface coming back.
  const unavailable = resolved.loopbackOnly;
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
    listenSelection: formatListenInterfaces(requested),
    resolvedAddresses: resolved.addresses,
    warnings: resolved.warnings,
    advertisedHosts,
    tailnetSelected,
    tailnetResolved,
    unavailable,
  };
};
