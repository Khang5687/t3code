import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ListenInterfaces,
  exposurePresetOf,
  legacyExposureModeOf,
  listenInterfacesForLegacyExposureMode,
  listenInterfacesForPreset,
  normalizeListenInterfaces,
} from "./exposure.ts";

const decode = Schema.decodeUnknownSync(ListenInterfaces);

describe("ListenInterfaces schema", () => {
  it("rejects unknown kinds", () => {
    expect(() => decode({ kinds: ["loopback", "wifi"] })).toThrow();
  });

  it("rejects non-IPv4 address strings", () => {
    expect(() => decode({ kinds: ["loopback"], addresses: ["::1"] })).toThrow();
    expect(() => decode({ kinds: ["loopback"], addresses: ["10.0.0.256"] })).toThrow();
    expect(() => decode({ kinds: ["loopback"], addresses: ["example.com"] })).toThrow();
  });

  it("adds loopback when the input omits it", () => {
    expect(decode({ kinds: ["lan"] })).toEqual({ kinds: ["loopback", "lan"], addresses: [] });
  });

  it("dedupes and orders kinds and addresses", () => {
    expect(
      decode({
        kinds: ["lan", "tailnet", "lan", "loopback"],
        addresses: ["10.0.0.5", "10.0.0.5", "192.168.1.2"],
      }),
    ).toEqual({
      kinds: ["loopback", "tailnet", "lan"],
      addresses: ["10.0.0.5", "192.168.1.2"],
    });
  });

  it("normalizes without the schema too", () => {
    expect(normalizeListenInterfaces({ kinds: [] })).toEqual({
      kinds: ["loopback"],
      addresses: [],
    });
  });
});

describe("exposure presets", () => {
  it("round-trips the three named presets", () => {
    for (const preset of ["local-only", "tailscale-only", "lan"] as const) {
      expect(exposurePresetOf(listenInterfacesForPreset(preset))).toBe(preset);
    }
  });

  it("derives the expected kind sets", () => {
    expect(listenInterfacesForPreset("local-only").kinds).toEqual(["loopback"]);
    expect(listenInterfacesForPreset("tailscale-only").kinds).toEqual(["loopback", "tailnet"]);
    expect(listenInterfacesForPreset("lan").kinds).toEqual(["loopback", "tailnet", "lan"]);
  });

  it("derives custom for any other selection", () => {
    expect(exposurePresetOf(decode({ kinds: ["loopback", "lan"] }))).toBe("custom");
    expect(exposurePresetOf(decode({ kinds: ["loopback"], addresses: ["10.0.0.5"] }))).toBe(
      "custom",
    );
    expect(
      exposurePresetOf(decode({ kinds: ["loopback", "tailnet", "lan"], addresses: ["10.0.0.5"] })),
    ).toBe("custom");
  });
});

describe("legacy exposure mode mapping", () => {
  it("maps legacy modes to selections", () => {
    expect(listenInterfacesForLegacyExposureMode("local-only")).toEqual(
      listenInterfacesForPreset("local-only"),
    );
    expect(listenInterfacesForLegacyExposureMode("network-accessible")).toEqual(
      listenInterfacesForPreset("lan"),
    );
  });

  it("derives local-only only for exactly {loopback} with no addresses", () => {
    expect(legacyExposureModeOf(decode({ kinds: ["loopback"] }))).toBe("local-only");
    expect(legacyExposureModeOf(decode({ kinds: ["loopback"], addresses: ["10.0.0.5"] }))).toBe(
      "network-accessible",
    );
    expect(legacyExposureModeOf(decode({ kinds: ["tailnet"] }))).toBe("network-accessible");
  });
});
