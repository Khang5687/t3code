import {
  exposurePresetOf,
  legacyExposureModeOf,
  listenInterfacesForPreset,
  normalizeListenInterfaces,
  type ExposurePreset,
  type LegacyExposureMode,
  type ListenInterfaces,
  type ListenInterfacesInput,
} from "@t3tools/contracts";
import {
  detectWslNetworking,
  isTailscaleIpv4Address,
  resolveListenAddresses,
  LOOPBACK_LISTEN_ADDRESS,
} from "@t3tools/tailscale";

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import type { NetworkInterfaces } from "./DesktopNetworkInterfaces.ts";

/** Mirrors the server: WSL kernels name themselves in the release string; unreadable means not WSL. */
const readOsRelease = (path: string): string | undefined => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const normalizeOptionalHost = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

export interface DesktopExposureResolution {
  /**
   * The selection as asked for. This is what the bootstrap envelope carries,
   * spelled with `formatListenInterfaces`: never a resolved IP, never a
   * wildcard (ADR 0003).
   */
  readonly requested: ListenInterfaces;
  readonly preset: ExposurePreset;
  /** Derived from the *effective* selection, so a request that resolved to nothing reads local-only. */
  readonly mode: LegacyExposureMode;
  readonly resolvedAddresses: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  /** Hosts the desktop-core endpoints advertise, in bind order. */
  readonly advertisedHosts: ReadonlyArray<string>;
  readonly tailnetSelected: boolean;
  /** A tailnet address resolved, so the Tailscale provider has one to advertise. */
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
  // Only true when the desktop itself runs inside a distro (WSLg). A Windows
  // desktop reads Windows' interfaces here and its WSL backend resolves the
  // same selection again in the distro, where it does its own detection.
  const resolved = resolveListenAddresses(
    requested,
    input.networkInterfaces,
    detectWslNetworking(input.networkInterfaces, process.env, readOsRelease),
  );
  const tailnetSelected = requested.kinds.includes("tailnet");
  // Serve and the tailnet endpoints need a real tailnet address, not just the
  // kind. The `lan` preset carries `tailnet`, so gating on the kind alone would
  // spawn the Tailscale CLI on every LAN machine without Tailscale installed,
  // raising the macOS "Other apps" TCC prompt for nothing. Gating on the address
  // instead also covers a tailnet address named explicitly without the kind,
  // which core no longer advertises.
  const tailnetResolved = resolved.addresses.some(isTailscaleIpv4Address);

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
            // Tailnet addresses belong to the Tailscale endpoint provider, which
            // labels them as private-network. Core never claims one, so nothing
            // reaches a client as "Local network" when it is not.
            !isTailscaleIpv4Address(address),
        );

  return {
    requested,
    preset: exposurePresetOf(requested),
    mode: legacyExposureModeOf(effective),
    resolvedAddresses: resolved.addresses,
    warnings: resolved.warnings,
    advertisedHosts,
    tailnetSelected,
    tailnetResolved,
    unavailable,
  };
};
