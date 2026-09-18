import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_PXPIPE_SIDECAR_PORT,
  PxpipeProxyStats,
  PxpipeSidecarSettings,
  PxpipeSidecarState,
} from "./sidecar.ts";

const decodeSettings = Schema.decodeUnknownSync(PxpipeSidecarSettings);
const decodeState = Schema.decodeUnknownSync(PxpipeSidecarState);
const decodeStats = Schema.decodeUnknownSync(PxpipeProxyStats);
const encodeStats = Schema.encodeSync(PxpipeProxyStats);

describe("PxpipeSidecarSettings", () => {
  it("is off by default and carries pxpipe's own port", () => {
    expect(decodeSettings({})).toEqual({
      enabled: false,
      port: DEFAULT_PXPIPE_SIDECAR_PORT,
      models: [],
      logPath: "",
      binaryPath: "",
      anthropicUpstream: "",
      extraEnv: [],
    });
  });

  it("keeps imaging off as a model list rather than a second disable flag", () => {
    expect(decodeSettings({ enabled: true, models: ["off"] })).toMatchObject({
      enabled: true,
      models: ["off"],
    });
  });

  it("rejects a port outside the range", () => {
    for (const port of [0, -1, 65536, 1.5]) {
      expect(() => decodeSettings({ port })).toThrow();
    }
  });

  it("carries untyped knobs such as HOST on extraEnv", () => {
    expect(decodeSettings({ extraEnv: [{ name: "HOST", value: "127.0.0.1" }] }).extraEnv).toEqual([
      { name: "HOST", value: "127.0.0.1", sensitive: false },
    ]);
  });
});

describe("PxpipeSidecarState", () => {
  it("decodes a supervised process and a failure with no process", () => {
    expect(
      decodeState({
        status: "healthy",
        port: DEFAULT_PXPIPE_SIDECAR_PORT,
        version: "0.13.2",
        pid: 4321,
        restartCount: 0,
        lastError: null,
      }).status,
    ).toBe("healthy");

    expect(
      decodeState({
        status: "failed",
        port: DEFAULT_PXPIPE_SIDECAR_PORT,
        version: "",
        pid: null,
        restartCount: 5,
        lastError: "connect ECONNREFUSED",
      }),
    ).toMatchObject({ pid: null, restartCount: 5, lastError: "connect ECONNREFUSED" });
  });

  it("rejects a status this build does not know", () => {
    expect(() =>
      decodeState({
        status: "warming-up",
        port: DEFAULT_PXPIPE_SIDECAR_PORT,
        version: "0.13.2",
        pid: null,
        restartCount: 0,
        lastError: null,
      }),
    ).toThrow();
  });
});

describe("PxpipeProxyStats", () => {
  // pxpipe owns this payload. A patch release that adds, renames or retypes a
  // key must leave the card rendering rather than fail the whole decode.
  it("keeps every key of an arbitrary stats object through a round trip", () => {
    const stats = {
      requests: 802,
      compressed_requests: 611,
      saved_pct: 65.1,
      saved_usd: 178.89,
      uptime_sec: 593_640,
      compression_enabled: true,
      render_cache: { entries: 12, bytes: 4096 },
      a_key_this_build_has_never_heard_of: ["anything", 1, null],
    };

    expect(decodeStats(stats)).toEqual(stats);
    expect(encodeStats(decodeStats(stats))).toEqual(stats);
  });

  it("accepts a known key whose type changed upstream", () => {
    expect(decodeStats({ saved_pct: "65.1" })).toEqual({ saved_pct: "65.1" });
  });
});
