import { describe, expect, it } from "vite-plus/test";

import { resolveListenAddress, type NetworkInterfacesMap } from "./listenAddress.ts";

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
      bindHost: "127.0.0.1",
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
    expect(listen.bindHost).toBe("::1");
    expect(listen.urlHost).toBe("[::1]");
    expect(listen.connectionHost).toBe("::1");
  });

  it("binds a wildcard host verbatim and advertises no URL host", () => {
    const listen = resolveListenAddress("0.0.0.0", externalIpv4Interfaces);

    expect(listen.kind).toBe("wildcard");
    expect(listen.bindHost).toBe("0.0.0.0");
    expect(listen.urlHost).toBeUndefined();
    expect(listen.connectionHost).toBe("192.168.1.42");
  });

  it("falls back to localhost for a wildcard host with no external interface", () => {
    expect(resolveListenAddress("::", noInterfaces).connectionHost).toBe("localhost");
  });

  it("keeps an explicit remote host for binding, URLs, and the connection string", () => {
    const listen = resolveListenAddress("[fd7a:115c::1]", noInterfaces);

    expect(listen.kind).toBe("explicit");
    expect(listen.bindHost).toBe("[fd7a:115c::1]");
    expect(listen.remoteReachable).toBe(true);
    expect(listen.urlHost).toBe("[fd7a:115c::1]");
    expect(listen.connectionHost).toBe("fd7a:115c::1");
  });
});

describe("resolveListenAddress with a listen-interface selection", () => {
  it("binds the tailnet address and advertises it for remote clients", () => {
    const listen = resolveListenAddress("tailnet", tailnetInterfaces);

    expect(listen.kind).toBe("explicit");
    expect(listen.bindHost).toBe("100.101.102.103");
    expect(listen.remoteReachable).toBe(true);
    expect(listen.configuredHost).toBe("tailnet");
    expect(listen.urlHost).toBe("100.101.102.103");
    expect(listen.connectionHost).toBe("100.101.102.103");
  });

  it("names the addresses it could not bind while only one listener exists", () => {
    const listen = resolveListenAddress("tailnet", tailnetInterfaces);

    expect(listen.warnings).toHaveLength(1);
    expect(listen.warnings[0]).toContain("127.0.0.1");
  });

  it("falls back to loopback with a warning when the tailnet is absent", () => {
    const listen = resolveListenAddress("tailnet", externalIpv4Interfaces);

    expect(listen.kind).toBe("loopback");
    expect(listen.bindHost).toBe("127.0.0.1");
    expect(listen.remoteReachable).toBe(false);
    expect(listen.warnings.some((warning) => /tailscale address/i.test(warning))).toBe(true);
    expect(listen.warnings.some((warning) => /loopback only/i.test(warning))).toBe(true);
  });

  it("binds loopback with no warnings when loopback is all that was asked for", () => {
    const listen = resolveListenAddress("loopback", tailnetInterfaces);

    expect(listen.kind).toBe("loopback");
    expect(listen.bindHost).toBe("127.0.0.1");
    expect(listen.remoteReachable).toBe(false);
    expect(listen.warnings).toEqual([]);
  });

  it("skips the tailnet address when only lan was selected", () => {
    const listen = resolveListenAddress("lan", tailnetInterfaces);

    expect(listen.bindHost).toBe("192.168.1.42");
    expect(listen.remoteReachable).toBe(true);
  });

  it("binds an explicitly listed address that is present on an interface", () => {
    const listen = resolveListenAddress("loopback,192.168.1.42", tailnetInterfaces);

    expect(listen.bindHost).toBe("192.168.1.42");
    expect(listen.remoteReachable).toBe(true);
  });

  it("still binds a single legacy host verbatim rather than resolving interfaces", () => {
    expect(resolveListenAddress("0.0.0.0", tailnetInterfaces).kind).toBe("wildcard");
    expect(resolveListenAddress("192.168.1.42", tailnetInterfaces).bindHost).toBe("192.168.1.42");
  });
});
