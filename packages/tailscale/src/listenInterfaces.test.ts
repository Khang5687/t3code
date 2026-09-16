import { describe, expect, it } from "vite-plus/test";

import { resolveListenAddresses, type NetworkInterfaceMap } from "./listenInterfaces.ts";

const lo = { address: "127.0.0.1", family: "IPv4", internal: true } as const;
const lo6 = { address: "::1", family: "IPv6", internal: true } as const;
const en0 = { address: "192.168.1.20", family: "IPv4", internal: false } as const;
const en0v6 = { address: "fe80::1", family: "IPv6", internal: false } as const;
const en1 = { address: "10.0.0.7", family: "IPv4", internal: false } as const;
const ts0 = { address: "100.101.102.103", family: "IPv4", internal: false } as const;

const interfaces: NetworkInterfaceMap = {
  lo0: [lo, lo6],
  en0: [en0, en0v6],
  en1: [en1],
  utun3: [ts0],
};

const select = (
  kinds: ReadonlyArray<"loopback" | "tailnet" | "lan">,
  addresses: ReadonlyArray<string> = [],
) => ({ kinds, addresses });

describe("resolveListenAddresses", () => {
  it("loopback only resolves to 127.0.0.1 without warnings", () => {
    expect(resolveListenAddresses(select(["loopback"]), interfaces)).toEqual({
      addresses: ["127.0.0.1"],
      warnings: [],
      loopbackOnly: false,
    });
  });

  it("tailnet resolves every CGNAT address and ignores the rest", () => {
    expect(resolveListenAddresses(select(["loopback", "tailnet"]), interfaces)).toEqual({
      addresses: ["127.0.0.1", "100.101.102.103"],
      warnings: [],
      loopbackOnly: false,
    });
  });

  it("lan resolves every non-tailnet external IPv4 across NICs, skipping IPv6 and internal", () => {
    expect(resolveListenAddresses(select(["loopback", "lan"]), interfaces)).toEqual({
      addresses: ["127.0.0.1", "192.168.1.20", "10.0.0.7"],
      warnings: [],
      loopbackOnly: false,
    });
  });

  it("orders loopback, tailnet, lan, explicit and dedupes", () => {
    expect(
      resolveListenAddresses(
        select(["loopback", "tailnet", "lan"], ["10.0.0.7", "127.0.0.1", "100.101.102.103"]),
        interfaces,
      ),
    ).toEqual({
      addresses: ["127.0.0.1", "100.101.102.103", "192.168.1.20", "10.0.0.7"],
      warnings: [],
      loopbackOnly: false,
    });
  });

  it("appends explicit addresses after the selected kinds", () => {
    expect(
      resolveListenAddresses(select(["loopback", "tailnet"], ["192.168.1.20"]), interfaces),
    ).toEqual({
      addresses: ["127.0.0.1", "100.101.102.103", "192.168.1.20"],
      warnings: [],
      loopbackOnly: false,
    });
  });

  it("warns when tailnet is selected but absent and continues with the rest", () => {
    const { lo0, en0: wifi } = interfaces;
    const result = resolveListenAddresses(select(["loopback", "tailnet", "lan"]), {
      lo0,
      en0: wifi,
    });
    expect(result.addresses).toEqual(["127.0.0.1", "192.168.1.20"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/tailnet/i);
  });

  it("skips an explicit address missing from every interface with a warning naming it", () => {
    const result = resolveListenAddresses(
      select(["loopback"], ["172.16.0.9", "10.0.0.7"]),
      interfaces,
    );
    expect(result.addresses).toEqual(["127.0.0.1", "10.0.0.7"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("172.16.0.9");
  });

  it("accepts an explicit loopback address without an interface entry", () => {
    expect(resolveListenAddresses(select(["loopback"], ["127.0.0.1"]), {})).toEqual({
      addresses: ["127.0.0.1"],
      warnings: [],
      loopbackOnly: false,
    });
  });

  it("adds a loopback-only warning when more was requested but nothing else resolved", () => {
    const result = resolveListenAddresses(select(["loopback", "tailnet"], ["172.16.0.9"]), {
      lo0: [lo, lo6],
    });
    expect(result.addresses).toEqual(["127.0.0.1"]);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.at(-1)).toMatch(/loopback only/i);
    expect(result.loopbackOnly).toBe(true);
  });

  it("reads the numeric IPv4 family some Node builds report", () => {
    expect(
      resolveListenAddresses(select(["loopback", "lan"]), {
        lo0: [{ address: "127.0.0.1", family: 4, internal: true }],
        en0: [{ address: "192.168.1.20", family: 4, internal: false }],
      }),
    ).toEqual({ addresses: ["127.0.0.1", "192.168.1.20"], warnings: [], loopbackOnly: false });
  });

  it("does not add a loopback-only warning when only loopback was requested", () => {
    const result = resolveListenAddresses(select(["loopback"]), {});
    expect(result.warnings).toEqual([]);
    expect(result.loopbackOnly).toBe(false);
  });
});
