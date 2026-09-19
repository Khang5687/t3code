// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- A socket accept hook runs outside any Effect runtime.
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

/**
 * Peer filtering on the accepted socket (ADR 0003). Choosing a bind interface
 * decides which NICs carry a listener; an allowlist decides which peers on
 * those NICs get past `accept()`. A rejected peer is destroyed before a byte of
 * its request is parsed, so HTTP, `/health`, pairing and the `/ws` upgrade are
 * all covered by the one hook rather than each route growing a check.
 *
 * Deliberately IPv4 only, matched against the kernel's view of the peer.
 * `X-Forwarded-For` and other reverse-proxy headers are ignored: behind a proxy
 * every peer is the proxy, and trusting a client-settable header here would
 * turn the allowlist into a suggestion.
 */

interface Cidr {
  readonly network: number;
  readonly mask: number;
}

/**
 * Strict decimal parse. `Number` takes "", " 5", "0x10" and "1e2", so a bare
 * `Number(prefix)` would read the typo `10.0.0.0/` as `/0` and allow the world.
 */
const decimal = (token: string): number | undefined =>
  /^\d{1,3}$/.test(token) ? Number(token) : undefined;

const ipv4ToInt = (address: string): number | undefined => {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    const octet = decimal(part);
    if (octet === undefined || octet > 255) {
      return undefined;
    }
    value = value * 256 + octet;
  }
  return value;
};

/** `a.b.c.d` (a host route) or `a.b.c.d/len`. Returns undefined for anything else. */
export const parseCidr = (entry: string): Cidr | undefined => {
  const parts = entry.split("/");
  const [address, prefix] = parts;
  if (parts.length > 2 || address === undefined) {
    return undefined;
  }
  const network = ipv4ToInt(address);
  if (network === undefined) {
    return undefined;
  }
  const length = prefix === undefined ? 32 : decimal(prefix);
  if (length === undefined || length > 32) {
    return undefined;
  }
  // `<<` on 32 is a no-op in JS, so /0 is spelled with the zero mask directly.
  const mask = length === 0 ? 0 : (-1 << (32 - length)) >>> 0;
  return { network: (network & mask) >>> 0, mask };
};

/**
 * The peer address as IPv4, or undefined when it is not IPv4 at all. Node
 * reports a v4 peer on a dual-stack socket as `::ffff:a.b.c.d`, and the IPv6
 * loopback is the same machine as the IPv4 one, so both are folded here rather
 * than at each call site.
 */
export const normalizePeerAddress = (address: string | undefined): string | undefined => {
  if (address === undefined) {
    return undefined;
  }
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  // Strip a zone id (`fe80::1%en0`) before comparing against the loopback form.
  const withoutZone = bare.split("%")[0] ?? bare;
  if (withoutZone === "::1") {
    return "127.0.0.1";
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(withoutZone);
  if (mapped?.[1] !== undefined) {
    return mapped[1];
  }
  return ipv4ToInt(withoutZone) === undefined ? undefined : withoutZone;
};

export const isPeerAllowed = (
  address: string | undefined,
  allowed: ReadonlyArray<Cidr>,
): boolean => {
  const normalized = normalizePeerAddress(address);
  if (normalized === undefined) {
    // An IPv6 peer that is not loopback or v4-mapped has no representation in
    // an IPv4 allowlist, so it cannot be on it.
    return false;
  }
  const value = ipv4ToInt(normalized);
  if (value === undefined) {
    return false;
  }
  return allowed.some((cidr) => (value & cidr.mask) >>> 0 === cidr.network);
};

const REJECTION_LOG_INTERVAL_MS = 60_000;
/** Bounds the rate-limit table; a scan past this drops peers that have gone quiet. */
const REJECTION_LOG_MAX_TRACKED_PEERS = 1_000;

/**
 * Destroys connections from peers outside `allowedPeers` before the HTTP parser
 * sees them, so a rejected peer gets a reset and zero response bytes. Entries
 * that do not parse as IPv4 or IPv4 CIDR are dropped rather than failing the
 * bind; the resolver always seeds loopback, so the list is never empty in
 * practice and a typo cannot lock the machine out of its own server.
 *
 * `onRejected` is called at most once per peer per minute, since a client that
 * retries in a loop would otherwise fill the log.
 */
export function guardPeerAllowlist<T extends NodeHttp.Server>(
  server: T,
  allowedPeers: ReadonlyArray<string>,
  onRejected?: (address: string) => void,
): T {
  const allowed = allowedPeers.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== undefined);
  const lastLoggedAt = new Map<string, number>();

  server.on("connection", (socket: NodeNet.Socket) => {
    const address = socket.remoteAddress;
    if (isPeerAllowed(address, allowed)) {
      return;
    }
    socket.destroy();

    if (onRejected === undefined) {
      return;
    }
    const peer = address ?? "unknown";
    const now = Date.now();
    const previous = lastLoggedAt.get(peer);
    if (previous !== undefined && now - previous < REJECTION_LOG_INTERVAL_MS) {
      return;
    }
    if (lastLoggedAt.size >= REJECTION_LOG_MAX_TRACKED_PEERS) {
      for (const [tracked, at] of lastLoggedAt) {
        if (now - at >= REJECTION_LOG_INTERVAL_MS) {
          lastLoggedAt.delete(tracked);
        }
      }
    }
    lastLoggedAt.set(peer, now);
    onRejected(peer);
  });

  return server;
}
