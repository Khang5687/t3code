// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import {
  type AllowedPeer,
  isIpv4Address,
  type ListenInterfaceKind,
  type ListenInterfaces,
  parseListenHostSelection,
} from "@t3tools/contracts";
import {
  detectWslNetworking,
  LOOPBACK_LISTEN_ADDRESS,
  resolveListenAddresses,
  type WslNetworking,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config.ts";

export type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

export type ListenAddressKind = "loopback" | "wildcard" | "explicit";

/**
 * The one reading of `config.host` the server acts on. Everything that used to
 * ask "is this host loopback / wildcard / remote" reads a field here instead,
 * so the derivation can change (ADR 0003) without touching its consumers.
 */
export interface ResolvedListenAddress {
  readonly kind: ListenAddressKind;
  /**
   * Every address the server opens a listening socket on, loopback first
   * (ADR 0003). A legacy verbatim host resolves to exactly one entry.
   */
  readonly bindHosts: ReadonlyArray<string>;
  /** Anything but loopback may receive connections from other machines. */
  readonly remoteReachable: boolean;
  /** The raw `--host` value; persisted runtime state and telemetry echo it. */
  readonly configuredHost: string | undefined;
  /** Bracketed hostname for building URLs when a concrete host was given. Wildcard and default binds have none. */
  readonly urlHost: string | undefined;
  /** Hostname a client on another machine dials to reach this server; wildcard binds pick an external interface. */
  readonly connectionHost: string;
  /** Why the bind differs from what was asked for; surfaced in runtime state and startup output. */
  readonly warnings: ReadonlyArray<string>;
  /**
   * CIDR blocks a peer must fall inside to get its socket accepted, or
   * `undefined` for no enforcement beyond the bind. Undefined whenever the
   * selection asked for no allowlist, so an untouched config keeps the exact
   * behaviour it had before the field existed.
   */
  readonly allowedPeers: ReadonlyArray<string> | undefined;
}

export const LOOPBACK_PEER_CIDR = "127.0.0.0/8";

/**
 * What each selected kind implies about who may connect. Applied on top of the
 * user's list rather than baked into the preset, so a preset stays a statement
 * about interfaces only.
 *
 * WSL needs nothing extra here: under NAT networking the Windows host reaches
 * the distro through the 172.16.0.0/12 gateway on the Hyper-V switch, which
 * `lan` already covers.
 */
const KIND_PEER_CIDRS: Record<ListenInterfaceKind, ReadonlyArray<string>> = {
  loopback: [LOOPBACK_PEER_CIDR],
  tailnet: ["100.64.0.0/10"],
  lan: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
};

/**
 * The list the socket guard enforces: what the user asked for, widened by the
 * default range of every selected kind and by a host route for each explicit
 * bind address, with loopback always present so the machine can never lock
 * itself out of its own server (ADR 0003).
 */
const effectiveAllowedPeers = (
  requested: ReadonlyArray<AllowedPeer>,
  kinds: ReadonlyArray<ListenInterfaceKind>,
  addresses: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const cidrs = new Set<string>([LOOPBACK_PEER_CIDR]);
  for (const peer of requested) {
    cidrs.add(peer.includes("/") ? peer : `${peer}/32`);
  }
  for (const kind of kinds) {
    for (const cidr of KIND_PEER_CIDRS[kind]) cidrs.add(cidr);
  }
  for (const address of addresses) {
    cidrs.add(`${address}/32`);
  }
  return [...cidrs];
};

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
};

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

const resolveConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap,
): string => {
  if (!host) {
    return "localhost";
  }

  if (!isWildcardHost(host)) {
    return normalizeHost(host);
  }

  const interfaceEntries = Object.values(interfaces).flatMap((entries) => entries ?? []);
  const externalIpv4 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv4Family(entry.family),
  );
  if (externalIpv4) {
    return externalIpv4.address;
  }

  const externalIpv6 = interfaceEntries.find(
    (entry) => !entry.internal && isIpv6Family(entry.family),
  );
  return externalIpv6 ? normalizeHost(externalIpv6.address) : "localhost";
};

/**
 * Every selected interface is bound, loopback included (ADR 0003). Loopback
 * leads the list, so local clients and the `origin` in runtime state stay on
 * 127.0.0.1 while remote clients are pointed at the first non-loopback address.
 */
const resolveFromInterfaces = (
  host: string | undefined,
  selection: ListenInterfaces,
  interfaces: NetworkInterfacesMap,
  wsl: WslNetworking,
): ResolvedListenAddress => {
  const resolved = resolveListenAddresses(selection, interfaces, wsl);
  // The resolver seeds loopback and applies the loopback-only fallback itself
  // (ADR 0003), so its list is final and never empty; all that is left here is
  // picking the address remote clients dial.
  const remote = resolved.addresses.find((address) => !isLoopbackHost(address));

  return {
    kind: remote === undefined ? "loopback" : "explicit",
    bindHosts: resolved.addresses,
    remoteReachable: remote !== undefined,
    configuredHost: host,
    urlHost: formatHostForUrl(resolved.addresses[0]),
    connectionHost: remote ?? LOOPBACK_LISTEN_ADDRESS,
    warnings: resolved.warnings,
    allowedPeers:
      selection.allowedPeers === undefined
        ? undefined
        : effectiveAllowedPeers(selection.allowedPeers, selection.kinds, selection.addresses),
  };
};

/** WSL kernels say so in their release string; unreadable means not WSL. */
const readOsRelease = (path: string): string | undefined => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

export const resolveListenAddress = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
  wsl: WslNetworking = detectWslNetworking(interfaces, process.env, readOsRelease),
): ResolvedListenAddress => {
  const parsed = parseListenHostSelection(host);
  if (parsed._tag === "interfaces") {
    return resolveFromInterfaces(host, parsed.interfaces, interfaces, wsl);
  }

  // `legacy` and `invalid` both bind the value verbatim. Every CLI path -- flag,
  // `T3CODE_HOST`, bootstrap envelope -- rejects an unparseable host before it
  // reaches here, so `invalid` only arrives from a direct call. Binding it and
  // letting the socket complain beats throwing from a pure resolver.
  // `allow:` entries are stripped by the parser, so the host to bind is the
  // parsed one; `host` itself still holds everything that was configured.
  const verbatimHost = parsed._tag === "legacy" ? parsed.host : host;
  const kind: ListenAddressKind = isWildcardHost(verbatimHost)
    ? "wildcard"
    : isLoopbackHost(verbatimHost)
      ? "loopback"
      : "explicit";
  // A verbatim host says "bind exactly this", so the bind is never narrowed to
  // match the allowlist. The allowlist is still enforced on the accepted
  // socket: asking for one and silently getting none is the failure mode worth
  // avoiding. A wildcard bind plus an allowlist is legal but surprising enough
  // to warn about, since the listener is on every NIC and only the guard is
  // keeping strangers out.
  const requestedPeers = parsed._tag === "legacy" ? (parsed.allowedPeers ?? []) : [];
  const boundAddress =
    verbatimHost !== undefined && !isWildcardHost(verbatimHost) && isIpv4Address(verbatimHost)
      ? [verbatimHost]
      : [];
  return {
    kind,
    bindHosts: [verbatimHost ?? LOOPBACK_LISTEN_ADDRESS],
    remoteReachable: kind !== "loopback",
    configuredHost: host,
    urlHost:
      verbatimHost !== undefined && kind !== "wildcard"
        ? formatHostForUrl(verbatimHost)
        : undefined,
    connectionHost: resolveConnectionHost(verbatimHost, interfaces),
    warnings:
      requestedPeers.length > 0 && kind === "wildcard"
        ? [
            `host ${verbatimHost} listens on every interface; only the peer allowlist (${requestedPeers.join(", ")}) keeps other machines out`,
          ]
        : [],
    allowedPeers:
      requestedPeers.length > 0
        ? effectiveAllowedPeers(requestedPeers, [], boundAddress)
        : undefined,
  };
};

export class ListenAddress extends Context.Service<ListenAddress, ResolvedListenAddress>()(
  "t3/listenAddress",
) {}

/** Resolves once per server launch. Tests inject `interfaces` to pin the wildcard connection host. */
export const layer = (options?: { readonly interfaces?: NetworkInterfacesMap }) =>
  Layer.effect(
    ListenAddress,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const listen = resolveListenAddress(
        config.host,
        options?.interfaces ?? NodeOS.networkInterfaces(),
      );
      // Logged here so every surface sees them, not just headless startup output.
      yield* Effect.forEach(listen.warnings, (warning) => Effect.logWarning(warning), {
        discard: true,
      });
      return listen;
    }),
  );
