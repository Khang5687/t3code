import * as NodeOS from "node:os";

import { type ListenInterfaces, parseListenHostSelection } from "@t3tools/contracts";
import { LOOPBACK_LISTEN_ADDRESS, resolveListenAddresses } from "@t3tools/tailscale";
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
  /** What the HTTP server passes to `listen()`. */
  readonly bindHost: string;
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
}

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
 * Interim single bind. A selection can resolve to several addresses, but one
 * `HttpServerLive` opens one socket, so the first non-loopback address wins —
 * that is what makes `--host tailnet` reachable on the tailnet rather than on
 * loopback. Every address that lost is named in a warning. The multi-bind
 * ticket replaces this with one listener per resolved address.
 */
const resolveFromInterfaces = (
  host: string | undefined,
  selection: ListenInterfaces,
  interfaces: NetworkInterfacesMap,
): ResolvedListenAddress => {
  const resolved = resolveListenAddresses(selection, interfaces);
  const bindHost =
    resolved.addresses.find((address) => address !== LOOPBACK_LISTEN_ADDRESS) ??
    LOOPBACK_LISTEN_ADDRESS;
  const dropped = resolved.addresses.filter((address) => address !== bindHost);
  const kind: ListenAddressKind = isLoopbackHost(bindHost) ? "loopback" : "explicit";

  return {
    kind,
    bindHost,
    remoteReachable: kind !== "loopback",
    configuredHost: host,
    urlHost: formatHostForUrl(bindHost),
    connectionHost: bindHost,
    warnings:
      dropped.length === 0
        ? resolved.warnings
        : [
            ...resolved.warnings,
            `binding ${bindHost} only; ${dropped.join(", ")} also resolved but binding every selected interface is not implemented yet`,
          ],
  };
};

export const resolveListenAddress = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): ResolvedListenAddress => {
  const parsed = parseListenHostSelection(host);
  if (parsed._tag === "interfaces") {
    return resolveFromInterfaces(host, parsed.interfaces, interfaces);
  }

  // `legacy` and `invalid` both bind the value verbatim. The CLI rejects an
  // unparseable `--host` up front, so reaching here with one means an older
  // desktop bootstrap envelope, which should still start the server.
  const kind: ListenAddressKind = isWildcardHost(host)
    ? "wildcard"
    : isLoopbackHost(host)
      ? "loopback"
      : "explicit";
  return {
    kind,
    bindHost: host ?? "127.0.0.1",
    remoteReachable: kind !== "loopback",
    configuredHost: host,
    urlHost: host !== undefined && kind !== "wildcard" ? formatHostForUrl(host) : undefined,
    connectionHost: resolveConnectionHost(host, interfaces),
    warnings: [],
  };
};

export class ListenAddress extends Context.Service<ListenAddress, ResolvedListenAddress>()(
  "t3/listenAddress",
) {}

/** Resolves once per server launch. Tests inject `interfaces` to pin the wildcard connection host. */
export const layer = (options?: { readonly interfaces?: NetworkInterfacesMap }) =>
  Layer.effect(
    ListenAddress,
    Effect.map(ServerConfig, (config) =>
      resolveListenAddress(config.host, options?.interfaces ?? NodeOS.networkInterfaces()),
    ),
  );
