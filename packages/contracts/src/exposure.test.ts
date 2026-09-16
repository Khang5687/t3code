import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ListenInterfaces,
  exposurePresetOf,
  formatListenInterfaces,
  listenInterfacesEqual,
  legacyExposureModeOf,
  listenInterfacesForLegacyExposureMode,
  listenInterfacesForPreset,
  normalizeListenInterfaces,
  parseListenHostSelection,
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

describe("formatListenInterfaces", () => {
  it("round-trips every selection back through the parser", () => {
    for (const selection of [
      decode({ kinds: ["loopback"] }),
      decode({ kinds: ["loopback", "tailnet"] }),
      decode({ kinds: ["loopback", "tailnet", "lan"] }),
      decode({ kinds: ["loopback"], addresses: ["10.0.0.5"] }),
      decode({ kinds: ["loopback", "lan"], addresses: ["10.0.0.5", "192.168.1.2"] }),
    ]) {
      expect(parseListenHostSelection(formatListenInterfaces(selection))).toEqual({
        _tag: "interfaces",
        interfaces: selection,
      });
    }
  });

  it("never emits a bare legacy host or a wildcard", () => {
    expect(formatListenInterfaces(listenInterfacesForPreset("local-only"))).toBe("loopback");
    expect(formatListenInterfaces(listenInterfacesForPreset("lan"))).toBe("loopback,tailnet,lan");
  });
});

describe("listenInterfacesEqual", () => {
  it("compares as sets, ignoring input order and duplicates", () => {
    expect(
      listenInterfacesEqual(
        normalizeListenInterfaces({ kinds: ["lan", "tailnet", "lan"] }),
        normalizeListenInterfaces({ kinds: ["tailnet", "lan", "loopback"] }),
      ),
    ).toBe(true);
    expect(
      listenInterfacesEqual(
        listenInterfacesForPreset("lan"),
        listenInterfacesForPreset("tailscale-only"),
      ),
    ).toBe(false);
    expect(
      listenInterfacesEqual(
        listenInterfacesForPreset("local-only"),
        normalizeListenInterfaces({ kinds: ["loopback"], addresses: ["10.0.0.5"] }),
      ),
    ).toBe(false);
  });

  it("ignores address order, which the serialized form does not", () => {
    const one = normalizeListenInterfaces({
      kinds: ["loopback"],
      addresses: ["10.0.0.5", "192.168.1.2"],
    });
    const other = normalizeListenInterfaces({
      kinds: ["loopback"],
      addresses: ["192.168.1.2", "10.0.0.5"],
    });

    expect(formatListenInterfaces(one)).not.toBe(formatListenInterfaces(other));
    expect(listenInterfacesEqual(one, other)).toBe(true);
  });
});

describe("parseListenHostSelection", () => {
  it("reads an unset or blank host as the legacy default", () => {
    for (const raw of [undefined, "", "  ", ","]) {
      expect(parseListenHostSelection(raw)).toEqual({ _tag: "legacy", host: undefined });
    }
  });

  it("keeps a single legacy host binding verbatim", () => {
    for (const host of [
      "127.0.0.1",
      "0.0.0.0",
      "192.168.1.42",
      "::",
      "::1",
      "[::1]",
      "localhost",
    ]) {
      expect(parseListenHostSelection(host)).toEqual({ _tag: "legacy", host });
    }
  });

  it("reads a lone kind keyword as a selection, always including loopback", () => {
    expect(parseListenHostSelection("tailnet")).toEqual({
      _tag: "interfaces",
      interfaces: { kinds: ["loopback", "tailnet"], addresses: [] },
    });
    expect(parseListenHostSelection("loopback")).toEqual({
      _tag: "interfaces",
      interfaces: { kinds: ["loopback"], addresses: [] },
    });
  });

  it("unions comma-separated kinds and IPv4 addresses in bind order", () => {
    expect(parseListenHostSelection("lan, tailnet ,10.0.0.5")).toEqual({
      _tag: "interfaces",
      interfaces: { kinds: ["loopback", "tailnet", "lan"], addresses: ["10.0.0.5"] },
    });
  });

  it("treats several addresses as a selection even without a kind keyword", () => {
    expect(parseListenHostSelection("10.0.0.5,192.168.1.42")).toEqual({
      _tag: "interfaces",
      interfaces: { kinds: ["loopback"], addresses: ["10.0.0.5", "192.168.1.42"] },
    });
  });

  it("dedupes repeated tokens so joined --host flags union", () => {
    expect(parseListenHostSelection("tailnet,tailnet,10.0.0.5,10.0.0.5")).toEqual({
      _tag: "interfaces",
      interfaces: { kinds: ["loopback", "tailnet"], addresses: ["10.0.0.5"] },
    });
  });

  it("rejects an unknown token and lists the accepted forms", () => {
    const parsed = parseListenHostSelection("tailnet,wifi");

    expect(parsed._tag).toBe("invalid");
    if (parsed._tag !== "invalid") return;
    expect(parsed.token).toBe("wifi");
    expect(parsed.message).toContain("wifi");
    for (const form of ["loopback", "tailnet", "lan", "IPv4", "--host"]) {
      expect(parsed.message).toContain(form);
    }
  });

  it("rejects a lone token that is neither a kind nor a legacy host", () => {
    expect(parseListenHostSelection("app.example.com")._tag).toBe("invalid");
    expect(parseListenHostSelection("10.0.0.256")._tag).toBe("invalid");
  });

  it("rejects a colon-bearing token that is not an IPv6 address", () => {
    // These used to pass as "contains a colon, must be IPv6" and only failed
    // later at bind time, with a DNS error instead of the accepted forms.
    for (const token of ["foo:bar", "host:3773", "tailnet:lan"]) {
      expect(parseListenHostSelection(token)._tag).toBe("invalid");
    }
  });

  it("still accepts every IPv6 form the old --host took", () => {
    for (const host of ["::", "::1", "[::1]", "fd7a:115c::1", "[fd7a:115c::1]", "fe80::1%en0"]) {
      expect(parseListenHostSelection(host)).toEqual({ _tag: "legacy", host });
    }
  });
});
