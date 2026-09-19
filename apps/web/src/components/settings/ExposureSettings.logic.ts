import {
  type ExposurePreset,
  type ListenInterfaces,
  normalizeListenInterfaces,
} from "@t3tools/contracts";

/**
 * Fork-only (ADR 0003). Pure parts of the Connections exposure control.
 */

// 127.0.0.0/8. An explicit loopback address reaches no further than the
// loopback kind every selection already carries, so adding one is not widening.
const isLoopbackAddress = (address: string): boolean => address.startsWith("127.");

/**
 * Whether `next` lets more peers connect than `current` does. Only a present
 * allowlist restricts anything, so gaining one is narrowing; losing one, or
 * gaining an entry the current list does not cover, is widening.
 */
const widensAllowlist = (current: ListenInterfaces, next: ListenInterfaces): boolean => {
  const currentPeers = current.allowedPeers;
  if (currentPeers === undefined || currentPeers.length === 0) {
    return false;
  }
  const nextPeers = next.allowedPeers ?? [];
  return nextPeers.length === 0 || nextPeers.some((peer) => !currentPeers.includes(peer));
};

/**
 * Whether applying `next` opens an interface, address, or peer beyond what the
 * server already accepts. Only a widening change is confirmed: narrowing back
 * towards loopback can never expose more than the user already accepted.
 */
export const widensExposure = (current: ListenInterfaces, next: ListenInterfaces): boolean =>
  next.kinds.some((kind) => kind !== "loopback" && !current.kinds.includes(kind)) ||
  next.addresses.some(
    (address) => !isLoopbackAddress(address) && !current.addresses.includes(address),
  ) ||
  widensAllowlist(current, next);

/**
 * Rebuild `current`'s binds while keeping its peer allowlist. The panel has no
 * allowlist editor (it is set with `--allow-peer`), so every edit it does make
 * has to carry the allowlist through or the relaunch would silently drop it.
 */
export const rebindSelection = (
  current: ListenInterfaces,
  binds: Pick<ListenInterfaces, "kinds" | "addresses">,
): ListenInterfaces =>
  normalizeListenInterfaces({
    ...binds,
    ...(current.allowedPeers ? { allowedPeers: current.allowedPeers } : {}),
  });

export const EXPOSURE_PRESET_OPTIONS: ReadonlyArray<{
  readonly preset: ExposurePreset;
  readonly label: string;
  readonly description: string;
}> = [
  {
    preset: "local-only",
    label: "Local only",
    description: "Only this machine reaches this environment.",
  },
  {
    preset: "tailscale-only",
    label: "Tailscale only",
    description: "Devices on your tailnet reach this environment.",
  },
  {
    preset: "lan",
    label: "LAN",
    description: "Your tailnet and this machine's local network reach this environment.",
  },
  {
    preset: "custom",
    label: "Custom",
    description: "Listen on the interfaces and addresses you pick.",
  },
];
