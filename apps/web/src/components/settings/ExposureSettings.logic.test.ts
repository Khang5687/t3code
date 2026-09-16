import { listenInterfacesForPreset, normalizeListenInterfaces } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { widensExposure } from "./ExposureSettings.logic";

const selection = (
  kinds: Parameters<typeof normalizeListenInterfaces>[0]["kinds"],
  addresses?: ReadonlyArray<string>,
) => normalizeListenInterfaces({ kinds, ...(addresses ? { addresses } : {}) });

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

  it("treats an unchanged selection as no widening", () => {
    expect(widensExposure(listenInterfacesForPreset("lan"), listenInterfacesForPreset("lan"))).toBe(
      false,
    );
  });
});
