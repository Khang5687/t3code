import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * Exposure as a set of listen interfaces (fork-only, ADR 0003). Loopback is
 * always part of the selection; the other kinds and explicit IPv4 addresses
 * are added on top. Kinds and addresses are kept deduped and in bind order
 * so two selections are equal when their arrays are.
 */
export const ListenInterfaceKind = Schema.Literals(["loopback", "tailnet", "lan"]);
export type ListenInterfaceKind = typeof ListenInterfaceKind.Type;

const LISTEN_INTERFACE_KIND_ORDER: ReadonlyArray<ListenInterfaceKind> = [
  "loopback",
  "tailnet",
  "lan",
];

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
export const Ipv4Address = Schema.String.check(
  Schema.isPattern(new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`)),
);
export type Ipv4Address = typeof Ipv4Address.Type;

export interface ListenInterfaces {
  readonly kinds: ReadonlyArray<ListenInterfaceKind>;
  readonly addresses: ReadonlyArray<Ipv4Address>;
}

export interface ListenInterfacesInput {
  readonly kinds: ReadonlyArray<ListenInterfaceKind>;
  readonly addresses?: ReadonlyArray<Ipv4Address>;
}

export const normalizeListenInterfaces = (input: ListenInterfacesInput): ListenInterfaces => {
  const requested = new Set(input.kinds);
  return {
    kinds: LISTEN_INTERFACE_KIND_ORDER.filter((kind) => kind === "loopback" || requested.has(kind)),
    addresses: [...new Set(input.addresses ?? [])],
  };
};

const NormalizedListenInterfaces = Schema.Struct({
  kinds: Schema.Array(ListenInterfaceKind),
  addresses: Schema.Array(Ipv4Address),
});

export const ListenInterfaces = Schema.Struct({
  kinds: Schema.Array(ListenInterfaceKind),
  addresses: Schema.optionalKey(Schema.Array(Ipv4Address)),
}).pipe(
  Schema.decodeTo(
    NormalizedListenInterfaces,
    SchemaTransformation.transform<ListenInterfaces, ListenInterfacesInput>({
      decode: normalizeListenInterfaces,
      encode: (selection) => selection,
    }),
  ),
);

export const ExposurePreset = Schema.Literals(["local-only", "tailscale-only", "lan", "custom"]);
export type ExposurePreset = typeof ExposurePreset.Type;
export type NamedExposurePreset = Exclude<ExposurePreset, "custom">;

const PRESET_KINDS: Record<NamedExposurePreset, ReadonlyArray<ListenInterfaceKind>> = {
  "local-only": ["loopback"],
  "tailscale-only": ["loopback", "tailnet"],
  lan: ["loopback", "tailnet", "lan"],
};

export const listenInterfacesForPreset = (preset: NamedExposurePreset): ListenInterfaces =>
  normalizeListenInterfaces({ kinds: PRESET_KINDS[preset] });

export const exposurePresetOf = (selection: ListenInterfaces): ExposurePreset => {
  if (selection.addresses.length > 0) {
    return "custom";
  }
  const kinds = normalizeListenInterfaces(selection).kinds.join(",");
  for (const preset of Object.keys(PRESET_KINDS) as ReadonlyArray<NamedExposurePreset>) {
    if (PRESET_KINDS[preset].join(",") === kinds) {
      return preset;
    }
  }
  return "custom";
};

/** Upstream's two-valued exposure mode, kept as a derived view of the selection. */
export type LegacyExposureMode = "local-only" | "network-accessible";

export const listenInterfacesForLegacyExposureMode = (mode: LegacyExposureMode): ListenInterfaces =>
  listenInterfacesForPreset(mode === "local-only" ? "local-only" : "lan");

export const legacyExposureModeOf = (selection: ListenInterfaces): LegacyExposureMode =>
  exposurePresetOf(selection) === "local-only" ? "local-only" : "network-accessible";
