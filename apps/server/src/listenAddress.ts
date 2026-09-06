import * as NodeOS from "node:os";

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

export const resolveListenAddress = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap = NodeOS.networkInterfaces(),
): ResolvedListenAddress => {
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
