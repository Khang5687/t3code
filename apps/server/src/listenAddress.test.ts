import { describe, expect, it } from "vite-plus/test";

import {
  LOOPBACK_PEER_CIDR,
  resolveListenAddress,
  type NetworkInterfacesMap,
} from "./listenAddress.ts";

const noInterfaces: NetworkInterfacesMap = {};

const externalIpv4Interfaces: NetworkInterfacesMap = {
  en0: [
    {
      address: "192.168.1.42",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "192.168.1.42/24",
    },
  ],
  lo0: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
};

const ipv4 = (address: string, internal: boolean) => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4" as const,
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

const tailnetInterfaces: NetworkInterfacesMap = {
  lo0: [ipv4("127.0.0.1", true)],
  en0: [ipv4("192.168.1.42", false)],
  utun3: [ipv4("100.101.102.103", false)],
};

describe("resolveListenAddress", () => {
  it("defaults an unset host to loopback", () => {
    const listen = resolveListenAddress(undefined, noInterfaces);

    expect(listen).toEqual({
      kind: "loopback",
      bindHosts: ["127.0.0.1"],
      remoteReachable: false,
      configuredHost: undefined,
      urlHost: undefined,
      connectionHost: "localhost",
      warnings: [],
    });
  });

  it("classifies loopback aliases separately from remotely reachable hosts", () => {
    const remoteReachable = (host: string | undefined) =>
      resolveListenAddress(host, noInterfaces).remoteReachable;

    expect(remoteReachable(undefined)).toBe(false);
    expect(remoteReachable("localhost")).toBe(false);
    expect(remoteReachable("127.12.0.1")).toBe(false);
    expect(remoteReachable("[::1]")).toBe(false);
    expect(remoteReachable("0.0.0.0")).toBe(true);
    expect(remoteReachable("::")).toBe(true);
    expect(remoteReachable("192.168.1.50")).toBe(true);
    expect(remoteReachable("app.example.com")).toBe(true);
  });

  it("keeps an explicit loopback host verbatim for binding and URLs", () => {
    const listen = resolveListenAddress("::1", noInterfaces);

    expect(listen.kind).toBe("loopback");
    expect(listen.bindHosts).toEqual(["::1"]);
    expect(listen.urlHost).toBe("[::1]");
    expect(listen.connectionHost).toBe("::1");
  });

  it("binds a wildcard host verbatim and advertises no URL host", () => {
    const listen = resolveListenAddress("0.0.0.0", externalIpv4Interfaces);

    expect(listen.kind).toBe("wildcard");
    expect(listen.bindHosts).toEqual(["0.0.0.0"]);
    expect(listen.urlHost).toBeUndefined();
    expect(listen.connectionHost).toBe("192.168.1.42");
  });

  it("falls back to localhost for a wildcard host with no external interface", () => {
    expect(resolveListenAddress("::", noInterfaces).connectionHost).toBe("localhost");
  });

  it("keeps an explicit remote host for binding, URLs, and the connection string", () => {
    const listen = resolveListenAddress("[fd7a:115c::1]", noInterfaces);

    expect(listen.kind).toBe("explicit");
    expect(listen.bindHosts).toEqual(["[fd7a:115c::1]"]);
    expect(listen.remoteReachable).toBe(true);
    expect(listen.urlHost).toBe("[fd7a:115c::1]");
    expect(listen.connectionHost).toBe("fd7a:115c::1");
  });
});

describe("resolveListenAddress with a listen-interface selection", () => {
  it("binds loopback alongside the tailnet address and advertises the tailnet one", () => {
    const listen = resolveListenAddress("tailnet", tailnetInterfaces);

    expect(listen.kind).toBe("explicit");
    expect(listen.bindHosts).toEqual(["127.0.0.1", "100.101.102.103"]);
    expect(listen.remoteReachable).toBe(true);
    expect(listen.configuredHost).toBe("tailnet");
    // Local clients keep dialing loopback; only remote clients need the tailnet address.
    expect(listen.urlHost).toBe("127.0.0.1");
    expect(listen.connectionHost).toBe("100.101.102.103");
    expect(listen.warnings).toEqual([]);
  });

  it("falls back to loopback with a warning when the tailnet is absent", () => {
    const listen = resolveListenAddress("tailnet", externalIpv4Interfaces);

    expect(listen.kind).toBe("loopback");
    expect(listen.bindHosts).toEqual(["127.0.0.1"]);
    expect(listen.remoteReachable).toBe(false);
    expect(listen.warnings.some((warning) => /tailscale address/i.test(warning))).toBe(true);
    expect(listen.warnings.some((warning) => /loopback only/i.test(warning))).toBe(true);
  });

  it("binds loopback with no warnings when loopback is all that was asked for", () => {
    const listen = resolveListenAddress("loopback", tailnetInterfaces);

    expect(listen.kind).toBe("loopback");
    expect(listen.bindHosts).toEqual(["127.0.0.1"]);
    expect(listen.remoteReachable).toBe(false);
    expect(listen.warnings).toEqual([]);
  });

  it("skips the tailnet address when only lan was selected", () => {
    const listen = resolveListenAddress("lan", tailnetInterfaces);

    expect(listen.bindHosts).toEqual(["127.0.0.1", "192.168.1.42"]);
    expect(listen.connectionHost).toBe("192.168.1.42");
    expect(listen.remoteReachable).toBe(true);
  });

  it("binds every selected kind at once", () => {
    const listen = resolveListenAddress("tailnet,lan", tailnetInterfaces);

    expect(listen.bindHosts).toEqual(["127.0.0.1", "100.101.102.103", "192.168.1.42"]);
    expect(listen.remoteReachable).toBe(true);
  });

  it("binds an explicitly listed address that is present on an interface", () => {
    const listen = resolveListenAddress("loopback,192.168.1.42", tailnetInterfaces);

    expect(listen.bindHosts).toEqual(["127.0.0.1", "192.168.1.42"]);
    expect(listen.remoteReachable).toBe(true);
  });

  it("skips an explicit address that is on no interface and binds the rest", () => {
    const listen = resolveListenAddress("lan,203.0.113.7", tailnetInterfaces);

    expect(listen.bindHosts).toEqual(["127.0.0.1", "192.168.1.42"]);
    expect(listen.warnings.some((warning) => warning.includes("203.0.113.7"))).toBe(true);
  });

  it("still binds a single legacy host verbatim rather than resolving interfaces", () => {
    expect(resolveListenAddress("0.0.0.0", tailnetInterfaces).kind).toBe("wildcard");
    expect(resolveListenAddress("192.168.1.42", tailnetInterfaces).bindHosts).toEqual([
      "192.168.1.42",
    ]);
  });
});

// Order is an artifact of how the union is built; membership is the contract.
const peersOf = (host: string, interfaces: NetworkInterfacesMap = tailnetInterfaces) => {
  const peers = resolveListenAddress(host, interfaces).allowedPeers;
  return peers === undefined ? undefined : [...peers].sort();
};

describe("resolveListenAddress peer allowlist", () => {
  it("enforces nothing when no allowlist was asked for", () => {
    for (const host of [undefined, "loopback", "lan", "0.0.0.0", "192.168.1.42"]) {
      expect(resolveListenAddress(host, tailnetInterfaces).allowedPeers).toBeUndefined();
    }
  });

  it("narrows to the request rather than widening it by the selected kinds", () => {
    // `lan` still binds 192.168.1.42, but naming one peer must not admit all of
    // 10/8, 172.16/12 and 192.168/16, or the flag would restrict nothing.
    expect(peersOf("lan,allow:203.0.113.7")).toEqual([LOOPBACK_PEER_CIDR, "203.0.113.7/32"].sort());
    expect(peersOf("tailnet,allow:203.0.113.0/24")).toEqual(
      [LOOPBACK_PEER_CIDR, "203.0.113.0/24"].sort(),
    );
  });

  it("adds a host route for each explicitly bound address", () => {
    expect(peersOf("loopback,192.168.1.42,allow:203.0.113.7")).toEqual(
      ["127.0.0.0/8", "192.168.1.42/32", "203.0.113.7/32"].sort(),
    );
  });

  it("always includes loopback so the machine cannot lock itself out", () => {
    expect(peersOf("allow:203.0.113.0/24")).toEqual([LOOPBACK_PEER_CIDR, "203.0.113.0/24"].sort());
  });

  it("still enforces the allowlist on a verbatim host, and warns on a wildcard", () => {
    const wildcard = resolveListenAddress("0.0.0.0,allow:203.0.113.0/24", tailnetInterfaces);

    expect(wildcard.kind).toBe("wildcard");
    expect(wildcard.bindHosts).toEqual(["0.0.0.0"]);
    expect(peersOf("0.0.0.0,allow:203.0.113.0/24")).toEqual(
      [LOOPBACK_PEER_CIDR, "203.0.113.0/24"].sort(),
    );
    expect(wildcard.warnings.some((warning) => warning.includes("203.0.113.0/24"))).toBe(true);
    expect(wildcard.warnings.some((warning) => /every interface/i.test(warning))).toBe(true);
  });

  it("warns that an IPv6 bind refuses every IPv6 client", () => {
    const ipv6Message = /peer allowlist is IPv4-only/;

    expect(
      resolveListenAddress("fd7a:115c::1,allow:203.0.113.7", tailnetInterfaces).warnings.some(
        (warning) => ipv6Message.test(warning) && warning.includes("fd7a:115c::1"),
      ),
    ).toBe(true);
    // The v6 wildcard listens on v6 too, so it earns the warning as well.
    expect(
      resolveListenAddress("::,allow:203.0.113.7", tailnetInterfaces).warnings.some((warning) =>
        ipv6Message.test(warning),
      ),
    ).toBe(true);
    // `::1` is folded to 127.0.0.1 by the guard, so nobody is locked out.
    expect(
      resolveListenAddress("::1,allow:203.0.113.7", tailnetInterfaces).warnings.some((warning) =>
        ipv6Message.test(warning),
      ),
    ).toBe(false);
    // No allowlist, nothing to refuse anyone.
    expect(resolveListenAddress("fd7a:115c::1", tailnetInterfaces).warnings).toEqual([]);
  });

  it("adds a host route for a verbatim IPv4 bind and stays quiet about it", () => {
    const listen = resolveListenAddress("192.168.1.42,allow:203.0.113.7", tailnetInterfaces);

    expect(listen.bindHosts).toEqual(["192.168.1.42"]);
    expect(listen.warnings).toEqual([]);
    expect(peersOf("192.168.1.42,allow:203.0.113.7")).toEqual(
      [LOOPBACK_PEER_CIDR, "192.168.1.42/32", "203.0.113.7/32"].sort(),
    );
  });
});

const wslNatInterfaces: NetworkInterfacesMap = {
  lo: [ipv4("127.0.0.1", true)],
  eth0: [ipv4("172.28.240.3", false)],
};

describe("resolveListenAddress under WSL", () => {
  it("still binds the WSL address but says who can reach it", () => {
    const listen = resolveListenAddress("lan", wslNatInterfaces, "nat");

    expect(listen.bindHosts).toEqual(["127.0.0.1", "172.28.240.3"]);
    expect(listen.remoteReachable).toBe(true);
    expect(listen.warnings).toHaveLength(1);
    expect(listen.warnings[0]).toContain("only reachable from the Windows host");
  });

  it("sends a missing tailnet to the distro, not the machine", () => {
    const listen = resolveListenAddress("tailnet", wslNatInterfaces, "nat");

    expect(listen.warnings.some((warning) => /inside this WSL distro/i.test(warning))).toBe(true);
  });

  it("leaves a mirrored distro alone", () => {
    expect(
      resolveListenAddress(
        "lan",
        { lo: [ipv4("127.0.0.1", true)], loopback0: [], eth0: [ipv4("192.168.1.42", false)] },
        "mirrored",
      ).warnings,
    ).toEqual([]);
  });

  it("adds nothing when the server is not in WSL", () => {
    expect(resolveListenAddress("lan", externalIpv4Interfaces, "not-wsl").warnings).toEqual([]);
  });
});
