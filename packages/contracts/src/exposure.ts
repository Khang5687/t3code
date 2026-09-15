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
const IPV4_PATTERN = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`);
export const Ipv4Address = Schema.String.check(Schema.isPattern(IPV4_PATTERN));
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

// Deliberately a plain predicate, not `Schema.is`: a schema type guard narrows
// the token to `never` on its false branch, which the checks below still read.
const isIpv4Address = (token: string): boolean => IPV4_PATTERN.test(token);

const isListenInterfaceKind = (token: string): token is ListenInterfaceKind =>
  (LISTEN_INTERFACE_KIND_ORDER as ReadonlyArray<string>).includes(token);

// Every IPv6 form the old `--host` took, bracketed or not, including `::` and
// a zone id. Deliberately not "contains a colon": that let `foo:bar` through to
// the socket, which failed at bind with a DNS error instead of failing fast.
const IPV6_PATTERN = /^\[?[0-9a-f:]*:[0-9a-f:.]*(?:%[0-9a-z_.-]+)?\]?$/i;

/** A single token the old `--host` accepted, which still binds verbatim. */
const isLegacyHostToken = (token: string): boolean =>
  isIpv4Address(token) || IPV6_PATTERN.test(token) || token === "localhost";

export const LISTEN_HOST_ACCEPTED_FORMS =
  "an interface kind (loopback, tailnet, lan), an IPv4 address, or a single host to bind verbatim (for example 127.0.0.1, 0.0.0.0, ::1, or localhost). Combine kinds and addresses with commas, or repeat --host.";

/**
 * What one `--host` value (or `T3CODE_HOST`, or the bootstrap envelope's host)
 * asks for. A single legacy token still binds verbatim; anything else is read
 * as a listen-interface selection (ADR 0003). Repeated flags are joined with
 * commas before parsing, so they union here.
 */
export type ListenHostSelection =
  | { readonly _tag: "legacy"; readonly host: string | undefined }
  | { readonly _tag: "interfaces"; readonly interfaces: ListenInterfaces }
  | { readonly _tag: "invalid"; readonly token: string; readonly message: string };

export const parseListenHostSelection = (raw: string | undefined): ListenHostSelection => {
  const tokens = (raw ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return { _tag: "legacy", host: undefined };
  }

  const [only] = tokens;
  if (tokens.length === 1 && only !== undefined && !isListenInterfaceKind(only)) {
    return isLegacyHostToken(only)
      ? { _tag: "legacy", host: only }
      : {
          _tag: "invalid",
          token: only,
          message: `Unknown --host value "${only}". Expected ${LISTEN_HOST_ACCEPTED_FORMS}`,
        };
  }

  const kinds: Array<ListenInterfaceKind> = [];
  const addresses: Array<Ipv4Address> = [];
  for (const token of tokens) {
    if (isListenInterfaceKind(token)) {
      kinds.push(token);
    } else if (isIpv4Address(token)) {
      addresses.push(token);
    } else {
      return {
        _tag: "invalid",
        token,
        message: `Unknown --host value "${token}". Expected ${LISTEN_HOST_ACCEPTED_FORMS}`,
      };
    }
  }

  return { _tag: "interfaces", interfaces: normalizeListenInterfaces({ kinds, addresses }) };
};

/**
 * The `--host` spelling of a selection, for the desktop's bootstrap envelope:
 * the client sends what was asked for and the server resolves it. Round-trips
 * through `parseListenHostSelection`, because a selection always carries
 * `loopback`, so the value is never a bare legacy token.
 */
export const formatListenHostSelection = (selection: ListenInterfaces): string =>
  [...selection.kinds, ...selection.addresses].join(",");

/** Set equality on kinds and addresses; normalization makes the serialized forms comparable. */
export const listenInterfacesEqual = (a: ListenInterfaces, b: ListenInterfaces): boolean =>
  formatListenHostSelection(normalizeListenInterfaces(a)) ===
  formatListenHostSelection(normalizeListenInterfaces(b));

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
