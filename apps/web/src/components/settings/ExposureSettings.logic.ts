import type { ExposurePreset, ListenInterfaces } from "@t3tools/contracts";

/**
 * Fork-only (ADR 0003). Pure parts of the Connections exposure control.
 */

/**
 * Whether applying `next` opens an interface or address the server is not
 * already listening on. Only a widening change is confirmed: narrowing back
 * towards loopback can never expose more than the user already accepted.
 */
export const widensExposure = (current: ListenInterfaces, next: ListenInterfaces): boolean =>
  next.kinds.some((kind) => kind !== "loopback" && !current.kinds.includes(kind)) ||
  next.addresses.some((address) => !current.addresses.includes(address));

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

export const exposurePresetLabel = (preset: ExposurePreset): string =>
  EXPOSURE_PRESET_OPTIONS.find((option) => option.preset === preset)?.label ?? preset;
