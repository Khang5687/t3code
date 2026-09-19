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

const IPV4_CIDR_PATTERN = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}/(?:3[0-2]|[12]?\\d)$`);
export const Ipv4Cidr = Schema.String.check(Schema.isPattern(IPV4_CIDR_PATTERN));
export type Ipv4Cidr = typeof Ipv4Cidr.Type;

/** One entry of the peer allowlist: a bare address (host route) or a CIDR block. */
export const AllowedPeer = Schema.Union([Ipv4Address, Ipv4Cidr]);
export type AllowedPeer = typeof AllowedPeer.Type;

export interface ListenInterfaces {
  readonly kinds: ReadonlyArray<ListenInterfaceKind>;
  readonly addresses: ReadonlyArray<Ipv4Address>;
  /**
   * Peers allowed to open a connection at all, enforced on the accepted socket
   * before any HTTP byte is read. Absent means "no restriction beyond the
   * bind", which is the behaviour every selection had before the field existed;
   * an empty request normalizes back to absent so there is one spelling of it.
   */
  readonly allowedPeers?: ReadonlyArray<AllowedPeer>;
}

export interface ListenInterfacesInput {
  readonly kinds: ReadonlyArray<ListenInterfaceKind>;
  readonly addresses?: ReadonlyArray<Ipv4Address>;
  readonly allowedPeers?: ReadonlyArray<AllowedPeer>;
}

export const normalizeListenInterfaces = (input: ListenInterfacesInput): ListenInterfaces => {
  const requested = new Set(input.kinds);
  const allowedPeers = [...new Set(input.allowedPeers ?? [])];
  return {
    kinds: LISTEN_INTERFACE_KIND_ORDER.filter((kind) => kind === "loopback" || requested.has(kind)),
    addresses: [...new Set(input.addresses ?? [])],
    ...(allowedPeers.length > 0 ? { allowedPeers } : {}),
  };
};

const NormalizedListenInterfaces = Schema.Struct({
  kinds: Schema.Array(ListenInterfaceKind),
  addresses: Schema.Array(Ipv4Address),
  allowedPeers: Schema.optionalKey(Schema.Array(AllowedPeer)),
});

export const ListenInterfaces = Schema.Struct({
  kinds: Schema.Array(ListenInterfaceKind),
  addresses: Schema.optionalKey(Schema.Array(Ipv4Address)),
  allowedPeers: Schema.optionalKey(Schema.Array(AllowedPeer)),
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
export const isIpv4Address = (token: string): boolean => IPV4_PATTERN.test(token);

export const isIpv4Cidr = (token: string): boolean => IPV4_CIDR_PATTERN.test(token);

/** `allow:` marks a peer-allowlist entry so it cannot be read as a bind address. */
const ALLOWED_PEER_PREFIX = "allow:";

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
  "an interface kind (loopback, tailnet, lan), an IPv4 address, an allow:<ip|cidr> peer entry, or a single host to bind verbatim (for example 127.0.0.1, 0.0.0.0, ::1, or localhost). Combine kinds and addresses with commas, or repeat --host.";

/**
 * What one `--host` value (or `T3CODE_HOST`, or the bootstrap envelope's host)
 * asks for. A single legacy token still binds verbatim; anything else is read
 * as a listen-interface selection (ADR 0003). Repeated flags are joined with
 * commas before parsing, so they union here.
 */
export type ListenHostSelection =
  | {
      readonly _tag: "legacy";
      readonly host: string | undefined;
      /**
       * Present only when `allow:` entries accompanied a verbatim host. A
       * verbatim bind is not enforced against (the resolver warns instead), but
       * the request is kept so the warning can name what was dropped.
       */
      readonly allowedPeers?: ReadonlyArray<AllowedPeer>;
    }
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

  // Peer entries are split out first: they never name something to bind, so the
  // "is the rest a single verbatim host" question is asked without them.
  const allowedPeers: Array<AllowedPeer> = [];
  const bindTokens: Array<string> = [];
  for (const token of tokens) {
    if (!token.startsWith(ALLOWED_PEER_PREFIX)) {
      bindTokens.push(token);
      continue;
    }
    const peer = token.slice(ALLOWED_PEER_PREFIX.length);
    if (!isIpv4Address(peer) && !isIpv4Cidr(peer)) {
      return {
        _tag: "invalid",
        token,
        message: `Unknown --host value "${token}". Expected an IPv4 address or CIDR after allow:, for example allow:10.0.0.0/8.`,
      };
    }
    allowedPeers.push(peer);
  }

  const peers = allowedPeers.length > 0 ? { allowedPeers } : {};

  if (bindTokens.length === 0) {
    // `--allow-peer` on its own: loopback is the bind every selection carries.
    return { _tag: "interfaces", interfaces: normalizeListenInterfaces({ kinds: [], ...peers }) };
  }

  const [only] = bindTokens;
  if (bindTokens.length === 1 && only !== undefined && !isListenInterfaceKind(only)) {
    return isLegacyHostToken(only)
      ? { _tag: "legacy", host: only, ...peers }
      : {
          _tag: "invalid",
          token: only,
          message: `Unknown --host value "${only}". Expected ${LISTEN_HOST_ACCEPTED_FORMS}`,
        };
  }

  const kinds: Array<ListenInterfaceKind> = [];
  const addresses: Array<Ipv4Address> = [];
  for (const token of bindTokens) {
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

  return {
    _tag: "interfaces",
    interfaces: normalizeListenInterfaces({ kinds, addresses, ...peers }),
  };
};

/**
 * The `--host` spelling of a selection, for the desktop's bootstrap envelope:
 * the client sends what was asked for and the server resolves it. Round-trips
 * through `parseListenHostSelection`, because a selection always carries
 * `loopback`, so the value is never a bare legacy token.
 */
export const formatListenInterfaces = (selection: ListenInterfaces): string =>
  [
    ...selection.kinds,
    ...selection.addresses,
    ...(selection.allowedPeers ?? []).map((peer) => `${ALLOWED_PEER_PREFIX}${peer}`),
  ].join(",");

const sameMembers = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const members = new Set<string>(a);
  return b.every((value) => members.has(value));
};

/**
 * Set equality on kinds and addresses. Deliberately not a comparison of the
 * serialized form: equality is a property of the selection, not of its `--host`
 * spelling, and normalization fixes the order of kinds but not of addresses.
 * Both sides are deduped first, so equal length plus containment is set equality.
 */
export const listenInterfacesEqual = (a: ListenInterfaces, b: ListenInterfaces): boolean => {
  const left = normalizeListenInterfaces(a);
  const right = normalizeListenInterfaces(b);
  return (
    sameMembers(left.kinds, right.kinds) &&
    sameMembers(left.addresses, right.addresses) &&
    sameMembers(left.allowedPeers ?? [], right.allowedPeers ?? [])
  );
};

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
