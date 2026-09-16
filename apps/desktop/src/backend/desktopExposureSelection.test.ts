import { listenInterfacesForPreset } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { NetworkInterfaces } from "./DesktopNetworkInterfaces.ts";
import { resolveDesktopExposure } from "./desktopExposureSelection.ts";

const lanOnly: NetworkInterfaces = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
};

const lanAndTailnet: NetworkInterfaces = {
  ...lanOnly,
  tailscale0: [{ address: "100.90.1.2", family: "IPv4", internal: false }],
};

describe("resolveDesktopExposure", () => {
  it("advertises a LAN address only when lan is selected", () => {
    const withLan = resolveDesktopExposure({
      requested: listenInterfacesForPreset("lan"),
      networkInterfaces: lanOnly,
    });
    expect(withLan.advertisedHosts).toEqual(["192.168.1.20"]);

    const withoutLan = resolveDesktopExposure({
      requested: listenInterfacesForPreset("tailscale-only"),
      networkInterfaces: lanOnly,
    });
    expect(withoutLan.advertisedHosts).toEqual([]);
  });

  it("leaves tailnet addresses to the Tailscale endpoint provider", () => {
    const resolution = resolveDesktopExposure({
      requested: listenInterfacesForPreset("lan"),
      networkInterfaces: lanAndTailnet,
    });
    expect(resolution.resolvedAddresses).toEqual(["127.0.0.1", "100.90.1.2", "192.168.1.20"]);
    expect(resolution.advertisedHosts).toEqual(["192.168.1.20"]);
    expect(resolution.tailnetSelected).toBe(true);
    expect(resolution.tailnetResolved).toBe(true);
  });

  it("reports the tailnet unresolved when the kind is selected but absent", () => {
    const resolution = resolveDesktopExposure({
      requested: listenInterfacesForPreset("lan"),
      networkInterfaces: lanOnly,
    });
    expect(resolution.tailnetSelected).toBe(true);
    expect(resolution.tailnetResolved).toBe(false);
  });

  it("leaves an explicitly named tailnet address to the Tailscale provider", () => {
    const resolution = resolveDesktopExposure({
      requested: { kinds: ["loopback"], addresses: ["100.90.1.2"] },
      networkInterfaces: lanAndTailnet,
    });
    expect(resolution.tailnetSelected).toBe(false);
    expect(resolution.preset).toBe("custom");
    // Core advertises no tailnet address, so it never mislabels one as LAN.
    expect(resolution.advertisedHosts).toEqual([]);
    // The provider still covers it, so the address is not left unadvertised.
    expect(resolution.tailnetResolved).toBe(true);
  });

  it("advertises an explicit non-tailnet address the selection names", () => {
    const resolution = resolveDesktopExposure({
      requested: { kinds: ["loopback"], addresses: ["192.168.1.20"] },
      networkInterfaces: lanAndTailnet,
    });
    expect(resolution.advertisedHosts).toEqual(["192.168.1.20"]);
  });

  it("reports local-only when the request resolved to loopback alone", () => {
    const resolution = resolveDesktopExposure({
      requested: listenInterfacesForPreset("lan"),
      networkInterfaces: {},
    });
    expect(resolution.unavailable).toBe(true);
    expect(resolution.mode).toBe("local-only");
    expect(resolution.advertisedHosts).toEqual([]);
    expect(resolution.warnings).toContain("listening on loopback only");
    // The request itself survives, so the envelope still asks for the tailnet.
    expect(resolution.listenSelection).toBe("loopback,tailnet,lan");
  });

  it("never emits a resolved address or a wildcard as the listen host", () => {
    for (const preset of ["local-only", "tailscale-only", "lan"] as const) {
      const { listenSelection } = resolveDesktopExposure({
        requested: listenInterfacesForPreset(preset),
        networkInterfaces: lanAndTailnet,
      });
      expect(listenSelection).not.toContain("0.0.0.0");
      expect(listenSelection).not.toMatch(/\d+\.\d+\.\d+\.\d+/u);
    }
  });

  it("reads the numeric IPv4 family some Node builds report", () => {
    const resolution = resolveDesktopExposure({
      requested: listenInterfacesForPreset("lan"),
      networkInterfaces: { en0: [{ address: "192.168.1.20", family: 4, internal: false }] },
    });
    expect(resolution.advertisedHosts).toEqual(["192.168.1.20"]);
  });

  it("prefers an explicit advertised host override", () => {
    const resolution = resolveDesktopExposure({
      requested: listenInterfacesForPreset("lan"),
      networkInterfaces: lanOnly,
      advertisedHostOverride: "desktop.example.test",
    });
    expect(resolution.advertisedHosts).toEqual(["desktop.example.test"]);
  });
});
