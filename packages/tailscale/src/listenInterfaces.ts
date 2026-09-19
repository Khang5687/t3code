import type { ListenInterfaces } from "@t3tools/contracts";

import { isTailscaleIpv4Address } from "./tailscale.ts";

/** Structurally matches `os.networkInterfaces()` so callers can pass it straight through. */
export interface NetworkInterfaceAddress {
  readonly address: string;
  /** Node reports "IPv4" on most builds and the numeric 4 on some; both arrive here. */
  readonly family: string | number;
  readonly internal: boolean;
}

const isIpv4Family = (family: string | number): boolean =>
  family === "IPv4" || family === 4 || family === "4";
export type NetworkInterfaceMap = Readonly<
  Record<string, ReadonlyArray<NetworkInterfaceAddress> | undefined>
>;

export interface ResolvedListenAddresses {
  /**
   * Every address to bind, loopback first. Non-empty by construction, so no
   * caller needs a fallback of its own.
   */
  readonly addresses: readonly [string, ...Array<string>];
  readonly warnings: ReadonlyArray<string>;
  /**
   * The selection asked for more than loopback and nothing else resolved. The
   * verdict lives here so callers read it rather than deriving it again.
   */
  readonly loopbackOnly: boolean;
}

export const LOOPBACK_LISTEN_ADDRESS = "127.0.0.1";

/**
 * Where the process runs relative to WSL2, and which networking mode the
 * distro ended up with.
 */
export type WslNetworking = "not-wsl" | "nat" | "mirrored" | "unknown";

/**
 * True inside a WSL distro. WSL sets both variables for every process it
 * starts, including the server the desktop spawns through `wsl.exe`. The
 * optional reader covers a process that inherited neither, such as one started
 * by systemd in the distro: WSL kernels report "microsoft" in their release
 * string.
 */
export const isWslProcess = (
  env: Readonly<Record<string, string | undefined>>,
  readFile?: (path: string) => string | undefined,
): boolean =>
  env.WSL_DISTRO_NAME !== undefined ||
  env.WSL_INTEROP !== undefined ||
  (readFile?.("/proc/sys/kernel/osrelease") ?? "").toLowerCase().includes("microsoft");

/** The Hyper-V "vEthernet (WSL)" switch hands `eth0` an address in this block. */
const isWslNatAddress = (address: string): boolean => /^172\.(1[6-9]|2\d|3[01])\./.test(address);

/**
 * Reads the WSL2 networking mode from the interfaces the distro can see.
 *
 * The mode is set on the Windows side, in `%UserProfile%\.wslconfig`, which the
 * distro cannot read, so this is a heuristic on the result rather than a lookup
 * of the setting:
 *
 * - Mirrored (`networkingMode=mirrored`) gives the distro copies of Windows'
 *   own adapters, so `eth0` carries the real LAN address and a `loopback0`
 *   interface appears beside `lo`. That extra loopback is the cheapest
 *   giveaway, and NAT mode never has it.
 * - NAT (the default) puts every external address on the Hyper-V switch, so
 *   they all fall in 172.16.0.0/12 and only the Windows host can reach them.
 * - Anything else is `unknown`: a distro with extra bridges, or one with no
 *   external address yet. Callers warn on `unknown` the same way they warn on
 *   `nat`, because a wrong warning costs less than a bind nobody can reach.
 *
 * ponytail: a real LAN on 172.16.0.0/12 under mirrored mode without a
 * `loopback0` would read as `nat`. Fix by reading `/proc/net/route` for the
 * default gateway if that ever shows up in a report.
 */
export const detectWslNetworking = (
  interfaces: NetworkInterfaceMap,
  env: Readonly<Record<string, string | undefined>>,
  readFile?: (path: string) => string | undefined,
): WslNetworking => {
  if (!isWslProcess(env, readFile)) return "not-wsl";
  if (Object.keys(interfaces).some((name) => name.toLowerCase().startsWith("loopback"))) {
    return "mirrored";
  }
  const external = Object.values(interfaces)
    .flat()
    .filter(
      (entry): entry is NetworkInterfaceAddress =>
        entry !== undefined && isIpv4Family(entry.family) && !entry.internal,
    );
  if (external.length === 0) return "unknown";
  return external.every((entry) => isWslNatAddress(entry.address)) ? "nat" : "unknown";
};

/**
 * Resolves a listen-interface selection to the concrete IPv4 addresses to bind
 * (ADR 0003). Pure: the interface map is injected. This is the single home of
 * the fallback policy: a selection that asked for more than loopback but
 * resolved to loopback only still succeeds, with a warning.
 *
 * `wsl` only changes the warnings. Inside a distro the addresses a selection
 * resolves to are still the ones to bind; they just do not mean what the user
 * expects them to mean (ADR 0003).
 */
export function resolveListenAddresses(
  selection: ListenInterfaces,
  interfaces: NetworkInterfaceMap,
  wsl: WslNetworking = "not-wsl",
): ResolvedListenAddresses {
  const ipv4 = Object.values(interfaces)
    .flat()
    .filter(
      (entry): entry is NetworkInterfaceAddress =>
        entry !== undefined && isIpv4Family(entry.family),
    );
  const external = ipv4.filter((entry) => !entry.internal).map((entry) => entry.address);
  const tailnet = external.filter(isTailscaleIpv4Address);
  const lan = external.filter((address) => !isTailscaleIpv4Address(address));
  const present = new Set([LOOPBACK_LISTEN_ADDRESS, ...ipv4.map((entry) => entry.address)]);

  // Loopback is prepended rather than seeded, so the set holds exactly the
  // addresses beyond loopback and answers the loopback-only question directly.
  const beyondLoopback = new Set<string>();
  const warnings: Array<string> = [];

  if (selection.kinds.includes("tailnet")) {
    if (tailnet.length === 0) {
      // A distro sees Tailscale only if it runs in the distro, or if mirrored
      // mode copies the Windows interface in. Saying "no address was found"
      // there sends the user looking on the wrong machine.
      warnings.push(
        wsl === "not-wsl"
          ? "tailnet selected but no Tailscale address was found"
          : "Tailscale is not running inside this WSL distro. Install and start it in the distro, or use mirrored networking so the Windows Tailscale interface is visible.",
      );
    }
    for (const address of tailnet) beyondLoopback.add(address);
  }
  if (selection.kinds.includes("lan")) {
    for (const address of lan) beyondLoopback.add(address);
    if (lan.length > 0 && (wsl === "nat" || wsl === "unknown")) {
      warnings.push(
        `WSL2 NAT networking: ${lan.join(", ")} is only reachable from the Windows host, not the LAN. Set networkingMode=mirrored in %UserProfile%\\.wslconfig and run wsl --shutdown, or run T3 Code on Windows.`,
      );
    }
  }
  for (const address of selection.addresses) {
    if (present.has(address)) {
      beyondLoopback.add(address);
    } else {
      warnings.push(`address ${address} is not on any network interface; skipped`);
    }
  }

  beyondLoopback.delete(LOOPBACK_LISTEN_ADDRESS);
  const requestedMoreThanLoopback =
    selection.kinds.some((kind) => kind !== "loopback") ||
    selection.addresses.some((address) => address !== LOOPBACK_LISTEN_ADDRESS);
  const loopbackOnly = requestedMoreThanLoopback && beyondLoopback.size === 0;
  if (loopbackOnly) {
    warnings.push("listening on loopback only");
  }

  return { addresses: [LOOPBACK_LISTEN_ADDRESS, ...beyondLoopback], warnings, loopbackOnly };
}
