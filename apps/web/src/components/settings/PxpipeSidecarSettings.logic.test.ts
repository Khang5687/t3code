import { DEFAULT_PXPIPE_SIDECAR_PORT, type PxpipeSidecarState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pxpipeRoutingActive } from "@t3tools/client-runtime/state/pxpipe";
import {
  canRemovePxpipeCache,
  canStopPxpipe,
  describePxpipeStatsNote,
  formatModelAllowlist,
  isInvalidSidecarEnvironmentName,
  parseModelAllowlist,
  publishableSidecarEnvironment,
  pxpipeBaseUrl,
  pxpipeRoutingTrouble,
  readPxpipeStats,
} from "./PxpipeSidecarSettings.logic";

const EVERY_STATUS = ["disabled", "stopped", "starting", "healthy", "unhealthy", "failed"] as const;

const state = (overrides: Partial<PxpipeSidecarState> = {}): PxpipeSidecarState => ({
  status: "healthy",
  port: DEFAULT_PXPIPE_SIDECAR_PORT,
  version: "0.13.2",
  pid: 4242,
  adopted: false,
  restartCount: 0,
  lastError: null,
  ...overrides,
});

describe("canStopPxpipe", () => {
  it("offers Stop only while a supervised process exists", () => {
    expect(canStopPxpipe(state({ status: "healthy" }))).toBe(true);
    expect(canStopPxpipe(state({ status: "starting" }))).toBe(true);
    expect(canStopPxpipe(state({ status: "unhealthy" }))).toBe(true);
    expect(canStopPxpipe(state({ status: "stopped" }))).toBe(false);
    expect(canStopPxpipe(state({ status: "disabled" }))).toBe(false);
    expect(canStopPxpipe(state({ status: "failed" }))).toBe(false);
  });

  it("hides Stop for an adopted sidecar T3 Code never started", () => {
    expect(canStopPxpipe(state({ adopted: true, pid: null }))).toBe(false);
  });

  it("hides Stop before the first state arrives", () => {
    expect(canStopPxpipe(null)).toBe(false);
  });
});

describe("canRemovePxpipeCache", () => {
  it("refuses while the sidecar is running and allows it once stopped", () => {
    expect(canRemovePxpipeCache(state({ status: "healthy" }))).toBe(false);
    expect(canRemovePxpipeCache(state({ status: "starting" }))).toBe(false);
    expect(canRemovePxpipeCache(state({ adopted: true, pid: null }))).toBe(false);
    expect(canRemovePxpipeCache(state({ status: "stopped" }))).toBe(true);
    expect(canRemovePxpipeCache(state({ status: "disabled" }))).toBe(true);
    expect(canRemovePxpipeCache(state({ status: "failed" }))).toBe(true);
  });
});

describe("pxpipeBaseUrl", () => {
  it("resolves the loopback URL a routed instance would use", () => {
    expect(pxpipeBaseUrl(47821)).toBe("http://127.0.0.1:47821");
  });
});

describe("model allowlist", () => {
  it("splits on commas and whitespace and drops blanks", () => {
    expect(parseModelAllowlist("  claude-opus-4 , claude-sonnet-4\nhaiku  ")).toEqual([
      "claude-opus-4",
      "claude-sonnet-4",
      "haiku",
    ]);
  });

  it("treats an empty field as pxpipe's own default", () => {
    expect(parseModelAllowlist("   ")).toEqual([]);
    expect(formatModelAllowlist([])).toBe("");
  });

  it("round-trips a stored list back into the field", () => {
    expect(parseModelAllowlist(formatModelAllowlist(["a", "b"]))).toEqual(["a", "b"]);
  });
});

describe("publishableSidecarEnvironment", () => {
  it("drops a wholly blank row and publishes the rest", () => {
    expect(
      publishableSidecarEnvironment([
        { id: "1", name: "HOST", value: "0.0.0.0", sensitive: false },
        { id: "2", name: "", value: "", sensitive: true },
      ]),
    ).toEqual([{ name: "HOST", value: "0.0.0.0", sensitive: false }]);
  });

  it("holds the whole list back while a name is half-typed", () => {
    expect(
      publishableSidecarEnvironment([
        { id: "1", name: "HOST", value: "0.0.0.0", sensitive: false },
        { id: "2", name: "2BAD", value: "x", sensitive: true },
      ]),
    ).toBeNull();
  });

  it("keeps the redaction marker so the server leaves the stored secret alone", () => {
    expect(
      publishableSidecarEnvironment([
        { id: "1", name: "PXPIPE_TOKEN", value: "", sensitive: true, valueRedacted: true },
      ]),
    ).toEqual([{ name: "PXPIPE_TOKEN", value: "", sensitive: true, valueRedacted: true }]);
  });
});

describe("readPxpipeStats", () => {
  it("narrows the keys the card renders", () => {
    expect(
      readPxpipeStats({
        requests: 802,
        compressed_requests: 771,
        saved_pct: 65.1,
        saved_usd: 178.8899,
        uptime_sec: 593713.085,
        compression_enabled: true,
        render_cache: { entries: 292, bytes: 57017416, hits: 13443, misses: 292 },
        saved_pct_of_all_spend: 59,
      }),
    ).toEqual({
      requests: 802,
      compressedRequests: 771,
      savedPercent: 65.1,
      savedUsd: 178.8899,
      uptimeSeconds: 593713.085,
      compressionEnabled: true,
      renderCache: { entries: 292, bytes: 57017416, hits: 13443, misses: 292 },
    });
  });

  it("reads a missing or retyped key as absent instead of failing", () => {
    expect(readPxpipeStats({ requests: "802", saved_pct: 65.1, render_cache: "off" })).toEqual({
      requests: null,
      compressedRequests: null,
      savedPercent: 65.1,
      savedUsd: null,
      uptimeSeconds: null,
      compressionEnabled: null,
      renderCache: null,
    });
  });

  it("has nothing to render when the proxy answered nothing", () => {
    expect(readPxpipeStats(null)).toBeNull();
  });
});

describe("pxpipeRoutingTrouble", () => {
  it("draws no dot on an unrouted instance, whatever the sidecar is doing", () => {
    for (const status of EVERY_STATUS) {
      expect([status, pxpipeRoutingTrouble(false, state({ status }))]).toEqual([status, null]);
    }
    expect(pxpipeRoutingTrouble(false, state({ adopted: true, pid: null }))).toBeNull();
  });

  it("maps every status to a dot for a routed instance", () => {
    const keys = EVERY_STATUS.map(
      (status) => pxpipeRoutingTrouble(true, state({ status }))?.statusKey ?? null,
    );
    expect(keys).toEqual(["warning", "warning", null, null, "warning", "error"]);
  });

  it("stays quiet for a sidecar the user started themselves", () => {
    expect(pxpipeRoutingTrouble(true, state({ adopted: true, pid: null, version: "" }))).toBeNull();
    // Even one whose last supervised status was a failure: an adopted sidecar is
    // answering now, which is the only thing a routed turn needs.
    expect(
      pxpipeRoutingTrouble(true, state({ adopted: true, status: "failed", pid: null })),
    ).toBeNull();
  });

  it("draws nothing before the first state arrives, rather than a lie", () => {
    expect(pxpipeRoutingTrouble(true, null)).toBeNull();
  });

  it("explains the trouble and where to fix it", () => {
    expect(pxpipeRoutingTrouble(true, state({ status: "disabled" }))?.detail).toBe(
      "Routed through pxpipe, which is off. Check Settings → Sidecars → pxpipe.",
    );
  });
});

describe("pxpipeRoutingActive", () => {
  // `pxpipeRoutingActive` itself is covered in client-runtime; this is the
  // web-only pairing it exists for.
  it("draws no trouble dot for an instance the sidecar never serves", () => {
    expect(
      pxpipeRoutingTrouble(
        pxpipeRoutingActive({ routeThroughPxpipe: true }, [
          { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
        ]),
        state({ status: "failed" }),
      ),
    ).toBeNull();
  });
});

describe("isInvalidSidecarEnvironmentName", () => {
  it("flags a committed name that is not a variable name", () => {
    expect(isInvalidSidecarEnvironmentName("2BAD")).toBe(true);
    expect(isInvalidSidecarEnvironmentName("HAS SPACE")).toBe(true);
  });

  it("leaves a usable name, and a row not typed into yet, unflagged", () => {
    expect(isInvalidSidecarEnvironmentName("HOST")).toBe(false);
    expect(isInvalidSidecarEnvironmentName("_x1")).toBe(false);
    expect(isInvalidSidecarEnvironmentName("   ")).toBe(false);
    expect(isInvalidSidecarEnvironmentName("")).toBe(false);
  });
});

describe("describePxpipeStatsNote", () => {
  const stats = readPxpipeStats({ requests: 802, compression_enabled: true });

  it("says nothing answers when the proxy gave nothing back", () => {
    expect(describePxpipeStatsNote(state(), null)).toBe(
      "Nothing is answering on the proxy port yet.",
    );
  });

  // Figures plus a status of Off is the case that misleads: a routed turn still
  // fails, because the preflight wants a healthy sidecar.
  it("disowns figures from a proxy T3 Code is not supervising", () => {
    for (const status of ["disabled", "stopped", "unhealthy", "failed"] as const) {
      expect([status, describePxpipeStatsNote(state({ status }), stats)]).toEqual([
        status,
        "Something is answering on this port that T3 Code is not supervising, so these figures are not the sidecar's. Routed turns keep failing until the sidecar itself is running.",
      ]);
    }
  });

  it("owns the figures once the sidecar is running, adopted or starting", () => {
    expect(describePxpipeStatsNote(state({ status: "healthy" }), stats)).toBeNull();
    expect(describePxpipeStatsNote(state({ status: "starting" }), stats)).toBeNull();
    expect(describePxpipeStatsNote(state({ adopted: true, status: "stopped" }), stats)).toBeNull();
  });

  it("stays quiet before the first state arrives rather than disowning figures", () => {
    expect(describePxpipeStatsNote(null, stats)).toBeNull();
  });

  it("calls out pass-through on a sidecar that is running with compression off", () => {
    expect(
      describePxpipeStatsNote(
        state({ status: "healthy" }),
        readPxpipeStats({ compression_enabled: false }),
      ),
    ).toBe("Compression is off, so pxpipe is passing requests through.");
  });
});
