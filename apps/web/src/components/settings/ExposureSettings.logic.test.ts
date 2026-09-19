import { listenInterfacesForPreset, normalizeListenInterfaces } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { rebindSelection, widensExposure } from "./ExposureSettings.logic";

const selection = (
  kinds: Parameters<typeof normalizeListenInterfaces>[0]["kinds"],
  addresses?: ReadonlyArray<string>,
) => normalizeListenInterfaces({ kinds, ...(addresses ? { addresses } : {}) });

const allowlisted = (allowedPeers: ReadonlyArray<string>) =>
  normalizeListenInterfaces({ kinds: ["loopback", "tailnet", "lan"], allowedPeers });

describe("widensExposure", () => {
  it("confirms a preset that adds an interface kind", () => {
    expect(
      widensExposure(
        listenInterfacesForPreset("local-only"),
        listenInterfacesForPreset("tailscale-only"),
      ),
    ).toBe(true);
    expect(
      widensExposure(listenInterfacesForPreset("tailscale-only"), listenInterfacesForPreset("lan")),
    ).toBe(true);
  });

  it("applies a narrowing preset without confirmation", () => {
    expect(
      widensExposure(listenInterfacesForPreset("lan"), listenInterfacesForPreset("local-only")),
    ).toBe(false);
    expect(
      widensExposure(listenInterfacesForPreset("lan"), listenInterfacesForPreset("tailscale-only")),
    ).toBe(false);
  });

  it("confirms an added address and not a removed one", () => {
    expect(widensExposure(selection(["loopback"]), selection(["loopback"], ["10.0.0.5"]))).toBe(
      true,
    );
    expect(widensExposure(selection(["loopback"], ["10.0.0.5"]), selection(["loopback"]))).toBe(
      false,
    );
  });

  it("does not confirm an explicit loopback address", () => {
    expect(widensExposure(selection(["loopback"]), selection(["loopback"], ["127.0.0.1"]))).toBe(
      false,
    );
    expect(widensExposure(selection(["loopback"]), selection(["loopback"], ["127.1.2.3"]))).toBe(
      false,
    );
  });

  it("treats an unchanged selection as no widening", () => {
    expect(widensExposure(listenInterfacesForPreset("lan"), listenInterfacesForPreset("lan"))).toBe(
      false,
    );
  });

  it("confirms dropping or loosening a peer allowlist", () => {
    expect(widensExposure(allowlisted(["10.0.0.0/8"]), listenInterfacesForPreset("lan"))).toBe(
      true,
    );
    expect(
      widensExposure(allowlisted(["10.0.0.0/8"]), allowlisted(["10.0.0.0/8", "192.168.1.7"])),
    ).toBe(true);
  });

  it("applies a new or tightened peer allowlist without confirmation", () => {
    expect(widensExposure(listenInterfacesForPreset("lan"), allowlisted(["10.0.0.0/8"]))).toBe(
      false,
    );
    expect(
      widensExposure(allowlisted(["10.0.0.0/8", "192.168.1.7"]), allowlisted(["10.0.0.0/8"])),
    ).toBe(false);
    expect(widensExposure(allowlisted(["10.0.0.0/8"]), allowlisted(["10.0.0.0/8"]))).toBe(false);
  });
});

describe("rebindSelection", () => {
  it("carries the peer allowlist through every bind edit", () => {
    const current = allowlisted(["10.0.0.0/8", "192.168.1.7"]);
    for (const binds of [
      listenInterfacesForPreset("local-only"),
      { kinds: ["loopback", "tailnet"] as const, addresses: [] },
      { kinds: current.kinds, addresses: ["10.0.0.5"] },
      { kinds: current.kinds, addresses: [] },
    ]) {
      expect(rebindSelection(current, binds).allowedPeers).toEqual(["10.0.0.0/8", "192.168.1.7"]);
    }
  });

  it("rebinds kinds and addresses and leaves an allowlist-free selection alone", () => {
    expect(
      rebindSelection(listenInterfacesForPreset("lan"), {
        kinds: ["loopback"],
        addresses: ["10.0.0.5"],
      }),
    ).toEqual({ kinds: ["loopback"], addresses: ["10.0.0.5"] });
  });
});
