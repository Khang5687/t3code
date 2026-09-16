import type { ExposurePreset, ListenInterfaces } from "@t3tools/contracts";

/**
 * Fork-only (ADR 0003). Pure parts of the Connections exposure control.
 */

// 127.0.0.0/8. An explicit loopback address reaches no further than the
// loopback kind every selection already carries, so adding one is not widening.
const isLoopbackAddress = (address: string): boolean => address.startsWith("127.");

/**
 * Whether applying `next` opens an interface or address beyond loopback that the
 * server is not already listening on. Only a widening change is confirmed:
 * narrowing back towards loopback can never expose more than the user already
 * accepted.
 */
export const widensExposure = (current: ListenInterfaces, next: ListenInterfaces): boolean =>
  next.kinds.some((kind) => kind !== "loopback" && !current.kinds.includes(kind)) ||
  next.addresses.some(
    (address) => !isLoopbackAddress(address) && !current.addresses.includes(address),
  );

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
