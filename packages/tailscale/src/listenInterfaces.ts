import type { ListenInterfaces } from "@t3tools/contracts";

import { isTailscaleIpv4Address } from "./tailscale.ts";

/** Structurally matches `os.networkInterfaces()` so callers can pass it straight through. */
export interface NetworkInterfaceAddress {
  readonly address: string;
  readonly family: string;
  readonly internal: boolean;
}
export type NetworkInterfaceMap = Readonly<
  Record<string, ReadonlyArray<NetworkInterfaceAddress> | undefined>
>;

export interface ResolvedListenAddresses {
  readonly addresses: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export const LOOPBACK_LISTEN_ADDRESS = "127.0.0.1";

/**
 * Resolves a listen-interface selection to the concrete IPv4 addresses to bind
 * (ADR 0003). Pure: the interface map is injected. This is the single home of
 * the fallback policy: a selection that asked for more than loopback but
 * resolved to loopback only still succeeds, with a warning.
 */
export function resolveListenAddresses(
  selection: ListenInterfaces,
  interfaces: NetworkInterfaceMap,
): ResolvedListenAddresses {
  const ipv4 = Object.values(interfaces)
    .flat()
    .filter((entry): entry is NetworkInterfaceAddress => entry?.family === "IPv4");
  const external = ipv4.filter((entry) => !entry.internal).map((entry) => entry.address);
  const tailnet = external.filter(isTailscaleIpv4Address);
  const lan = external.filter((address) => !isTailscaleIpv4Address(address));
  const present = new Set([LOOPBACK_LISTEN_ADDRESS, ...ipv4.map((entry) => entry.address)]);

  const addresses = new Set<string>([LOOPBACK_LISTEN_ADDRESS]);
  const warnings: Array<string> = [];

  if (selection.kinds.includes("tailnet")) {
    if (tailnet.length === 0) {
      warnings.push("tailnet selected but no Tailscale address was found");
    }
    for (const address of tailnet) addresses.add(address);
  }
  if (selection.kinds.includes("lan")) {
    for (const address of lan) addresses.add(address);
  }
  for (const address of selection.addresses) {
    if (present.has(address)) {
      addresses.add(address);
    } else {
      warnings.push(`address ${address} is not on any network interface; skipped`);
    }
  }

  const requestedMoreThanLoopback =
    selection.kinds.some((kind) => kind !== "loopback") ||
    selection.addresses.some((address) => address !== LOOPBACK_LISTEN_ADDRESS);
  if (requestedMoreThanLoopback && addresses.size === 1) {
    warnings.push("listening on loopback only");
  }

  return { addresses: [...addresses], warnings };
}
