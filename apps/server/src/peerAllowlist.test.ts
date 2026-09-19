// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";

import {
  guardPeerAllowlist,
  isPeerAllowed,
  normalizePeerAddress,
  parseCidr,
} from "./peerAllowlist.ts";

const cidrs = (...entries: ReadonlyArray<string>) =>
  entries.map(parseCidr).filter((cidr) => cidr !== undefined);

/**
 * Drives the guard through the one event it hooks. A bare emitter stands in for
 * the server because a real `http.Server` attaches its own `connection`
 * handling and would demand a full socket; the guard only ever reads
 * `remoteAddress` and calls `destroy`.
 */
const connectionsFrom = (allowedPeers: ReadonlyArray<string>) => {
  const server = new NodeEvents.EventEmitter() as unknown as NodeHttp.Server;
  const rejected: Array<string> = [];
  const destroyed: Array<string> = [];
  guardPeerAllowlist(server, allowedPeers, (address) => rejected.push(address));

  return {
    rejected,
    destroyed,
    connect: (remoteAddress: string | undefined) => {
      const socket = {
        remoteAddress,
        destroy: () => destroyed.push(remoteAddress ?? "unknown"),
      };
      server.emit("connection", socket as unknown as NodeNet.Socket);
    },
  };
};

describe("parseCidr", () => {
  it("reads a bare address as a host route", () => {
    expect(parseCidr("10.0.0.5")).toEqual(parseCidr("10.0.0.5/32"));
  });

  it("masks the network bits off the given address", () => {
    // 10.1.2.3/8 and 10.0.0.0/8 describe the same block.
    expect(parseCidr("10.1.2.3/8")).toEqual(parseCidr("10.0.0.0/8"));
  });

  it("rejects anything that is not IPv4", () => {
    for (const entry of ["10.0.0.0/33", "10.0.0.256", "10.0.0", "::1", "", "10.0.0. 5/8"]) {
      expect(parseCidr(entry)).toBeUndefined();
    }
  });
});

describe("normalizePeerAddress", () => {
  it("unwraps a v4-mapped IPv6 peer, which is how Node reports one on a dual-stack socket", () => {
    expect(normalizePeerAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizePeerAddress("::ffff:10.0.0.5")).toBe("10.0.0.5");
  });

  it("treats the IPv6 loopback as the same machine", () => {
    expect(normalizePeerAddress("::1")).toBe("127.0.0.1");
    expect(normalizePeerAddress("[::1]")).toBe("127.0.0.1");
  });

  it("has no IPv4 reading for a real IPv6 peer", () => {
    expect(normalizePeerAddress("fd7a:115c::1")).toBeUndefined();
    expect(normalizePeerAddress("fe80::1%en0")).toBeUndefined();
    expect(normalizePeerAddress(undefined)).toBeUndefined();
  });
});

describe("isPeerAllowed", () => {
  const lan = cidrs("10.0.0.0/8", "192.168.1.0/24");

  it("matches inside a block and rejects just outside it", () => {
    expect(isPeerAllowed("10.255.255.255", lan)).toBe(true);
    expect(isPeerAllowed("192.168.1.7", lan)).toBe(true);
    expect(isPeerAllowed("11.0.0.1", lan)).toBe(false);
    expect(isPeerAllowed("192.168.2.7", lan)).toBe(false);
  });

  it("matches a v4-mapped peer against the same block", () => {
    expect(isPeerAllowed("::ffff:10.0.0.5", lan)).toBe(true);
    expect(isPeerAllowed("::ffff:11.0.0.5", lan)).toBe(false);
  });

  it("matches the IPv6 loopback against a loopback entry", () => {
    expect(isPeerAllowed("::1", cidrs("127.0.0.0/8"))).toBe(true);
    expect(isPeerAllowed("::1", lan)).toBe(false);
  });

  it("rejects an IPv6 peer that an IPv4 allowlist cannot describe", () => {
    expect(isPeerAllowed("fd7a:115c::1", cidrs("0.0.0.0/0"))).toBe(false);
  });

  it("takes every peer under /0 and none under an empty list", () => {
    expect(isPeerAllowed("203.0.113.7", cidrs("0.0.0.0/0"))).toBe(true);
    expect(isPeerAllowed("127.0.0.1", [])).toBe(false);
  });
});

describe("guardPeerAllowlist", () => {
  it("leaves an allowed peer alone and destroys everyone else", () => {
    const guard = connectionsFrom(["10.0.0.0/8"]);

    guard.connect("10.0.0.5");
    guard.connect("::ffff:10.1.2.3");
    expect(guard.destroyed).toEqual([]);

    guard.connect("203.0.113.7");
    guard.connect(undefined);
    expect(guard.destroyed).toEqual(["203.0.113.7", "unknown"]);
    expect(guard.rejected).toEqual(["203.0.113.7", "unknown"]);
  });

  it("logs a repeating peer once but still destroys every attempt", () => {
    const guard = connectionsFrom(["10.0.0.0/8"]);

    for (let attempt = 0; attempt < 5; attempt += 1) guard.connect("203.0.113.7");

    expect(guard.destroyed).toHaveLength(5);
    expect(guard.rejected).toEqual(["203.0.113.7"]);
  });

  it("drops an unparseable entry rather than failing the bind", () => {
    const guard = connectionsFrom(["not-an-address", "10.0.0.0/8"]);

    guard.connect("10.0.0.5");
    guard.connect("203.0.113.7");

    expect(guard.destroyed).toEqual(["203.0.113.7"]);
  });
});
