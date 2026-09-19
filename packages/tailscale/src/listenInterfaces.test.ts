import { describe, expect, it } from "vite-plus/test";

import {
  detectWslNetworking,
  resolveListenAddresses,
  type NetworkInterfaceMap,
} from "./listenInterfaces.ts";

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

  it("keeps the plain tailnet warning when not under WSL", () => {
    const result = resolveListenAddresses(select(["loopback", "lan", "tailnet"]), {
      lo0: [lo],
      en0: [en0],
    });
    expect(result.warnings).toEqual(["tailnet selected but no Tailscale address was found"]);
  });
});

const wslNat: NetworkInterfaceMap = {
  lo: [lo],
  eth0: [{ address: "172.28.240.3", family: "IPv4", internal: false }],
};
const wslMirrored: NetworkInterfaceMap = {
  lo: [lo],
  loopback0: [lo],
  eth0: [en0],
};
const wslEnv = { WSL_DISTRO_NAME: "Ubuntu" };
const wsl1Release = () => "4.4.0-19041-Microsoft";
const wsl2Release = () => "5.15.167.4-microsoft-standard-WSL2";

describe("detectWslNetworking", () => {
  it("reads a NAT distro from its 172.16.0.0/12 address", () => {
    expect(detectWslNetworking(wslNat, wslEnv)).toBe("nat");
  });

  it("reads a mirrored distro from the loopback0 interface", () => {
    expect(detectWslNetworking(wslMirrored, wslEnv)).toBe("mirrored");
  });

  it("is not-wsl without a WSL signal, whatever the interfaces look like", () => {
    expect(detectWslNetworking(wslNat, {})).toBe("not-wsl");
  });

  it("falls back to the kernel release when the env lost the WSL variables", () => {
    expect(detectWslNetworking(wslNat, {}, () => "5.15.167.4-microsoft-standard-WSL2")).toBe("nat");
  });

  it("reports unknown for a distro whose addresses match neither shape", () => {
    expect(detectWslNetworking(interfaces, wslEnv)).toBe("unknown");
    expect(detectWslNetworking({ lo: [lo] }, wslEnv)).toBe("unknown");
  });

  it("reads WSL1 from the capitalized kernel suffix, whatever the interfaces show", () => {
    // WSL1 sees Windows' own adapters, so the interface map is a normal LAN one
    // and would otherwise read as unknown.
    expect(detectWslNetworking(interfaces, wslEnv, wsl1Release)).toBe("wsl1");
    expect(detectWslNetworking({ lo: [lo], eth0: [en0] }, wslEnv, wsl1Release)).toBe("wsl1");
  });

  it("reads WSL1 from /proc/version when osrelease is unreadable", () => {
    const onlyVersion = (path: string) =>
      path === "/proc/version"
        ? "Linux version 4.4.0-18985-Microsoft (Microsoft@Microsoft.com)"
        : undefined;
    expect(detectWslNetworking(interfaces, wslEnv, onlyVersion)).toBe("wsl1");
  });

  it("does not call a WSL2 kernel WSL1, including the 4.19 builds with no WSL2 marker", () => {
    // Matching "no WSL2 in the string" instead of the capital M would misread
    // this one, which is why the check is a positive match on WSL1.
    expect(detectWslNetworking(wslNat, wslEnv, () => "4.19.67-microsoft-standard")).toBe("nat");
    expect(detectWslNetworking(wslMirrored, wslEnv, wsl2Release)).toBe("mirrored");
    expect(detectWslNetworking(wslNat, wslEnv, wsl2Release)).toBe("nat");
  });

  it("stays not-wsl for a kernel with no WSL signal at all", () => {
    expect(detectWslNetworking(interfaces, {}, () => "6.8.0-45-generic")).toBe("not-wsl");
  });
});

describe("resolveListenAddresses under WSL", () => {
  it("warns that a NAT lan bind only reaches the Windows host", () => {
    const result = resolveListenAddresses(select(["loopback", "lan"]), wslNat, "nat");
    expect(result.addresses).toEqual(["127.0.0.1", "172.28.240.3"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("172.28.240.3");
    expect(result.warnings[0]).toContain("networkingMode=mirrored");
  });

  it("warns the same way when the mode could not be read", () => {
    const result = resolveListenAddresses(select(["loopback", "lan"]), wslNat, "unknown");
    expect(result.warnings[0]).toContain("WSL2 NAT networking");
  });

  it("stays quiet about the lan bind under mirrored networking", () => {
    expect(
      resolveListenAddresses(select(["loopback", "lan"]), wslMirrored, "mirrored").warnings,
    ).toEqual([]);
  });

  it("points a missing tailnet at the distro rather than the machine", () => {
    const result = resolveListenAddresses(select(["loopback", "tailnet"]), wslNat, "nat");
    expect(result.warnings[0]).toContain("not running inside this WSL distro");
  });

  it("stays quiet about a lan bind under WSL1, which really does reach the LAN", () => {
    const result = resolveListenAddresses(select(["loopback", "lan"]), interfaces, "wsl1");
    expect(result.addresses).toEqual(["127.0.0.1", "192.168.1.20", "10.0.0.7"]);
    expect(result.warnings).toEqual([]);
  });

  it("never offers mirrored networking to WSL1, where .wslconfig does nothing", () => {
    const warnings = resolveListenAddresses(
      select(["loopback", "tailnet", "lan"]),
      { lo: [lo], eth0: [en0] },
      "wsl1",
    ).warnings;
    expect(warnings.join(" ")).not.toContain("networkingMode=mirrored");
  });

  it("points a missing tailnet at the Windows host under WSL1", () => {
    const result = resolveListenAddresses(
      select(["loopback", "tailnet"]),
      { lo: [lo], eth0: [en0] },
      "wsl1",
    );
    expect(result.warnings[0]).toContain("Windows host");
    expect(result.warnings[0]).not.toContain("Install and start it in the distro");
  });

  it("leaves a resolved tailnet address unwarned under WSL1", () => {
    expect(
      resolveListenAddresses(select(["loopback", "tailnet"]), interfaces, "wsl1").warnings,
    ).toEqual([]);
  });
});
