import { DEFAULT_PXPIPE_SIDECAR_PORT, type PxpipeSidecarState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describePxpipeStatus,
  pxpipeRoutingActive,
  pxpipeRoutingOverride,
  readRouteThroughPxpipe,
} from "./pxpipe.ts";

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

describe("describePxpipeStatus", () => {
  it("names every status the supervisor reports", () => {
    const labels = EVERY_STATUS.map((status) => describePxpipeStatus(state({ status })).label);
    expect(labels).toEqual(["Off", "Stopped", "Starting", "Running", "Unhealthy", "Failed"]);
  });

  it("says an adopted sidecar was started outside T3 Code", () => {
    expect(describePxpipeStatus(state({ adopted: true, pid: null, version: "" })).label).toBe(
      "Running (started outside T3 Code)",
    );
  });

  it("reads as loading before the first state arrives", () => {
    expect(describePxpipeStatus(null).label).toBe("Loading…");
  });
});

describe("pxpipeRoutingOverride", () => {
  it("says nothing on an unrouted instance, whatever it sets", () => {
    expect(
      pxpipeRoutingOverride(false, [
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]),
    ).toBeNull();
  });

  it("says nothing on a routed instance that leaves the base URL alone", () => {
    expect(pxpipeRoutingOverride(true, [])).toBeNull();
    expect(pxpipeRoutingOverride(true, undefined)).toBeNull();
  });

  it("explains why a routed instance with its own base URL is not routed", () => {
    expect(
      pxpipeRoutingOverride(true, [
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]),
    ).toContain("this instance sets ANTHROPIC_BASE_URL itself");
  });
});

describe("readRouteThroughPxpipe", () => {
  it("routes only on an explicit true in the instance config blob", () => {
    expect(readRouteThroughPxpipe({ routeThroughPxpipe: true })).toBe(true);
    expect(readRouteThroughPxpipe({ routeThroughPxpipe: false })).toBe(false);
    expect(readRouteThroughPxpipe({ routeThroughPxpipe: "true" })).toBe(false);
    expect(readRouteThroughPxpipe({ binaryPath: "/usr/local/bin/claude" })).toBe(false);
    expect(readRouteThroughPxpipe(null)).toBe(false);
    expect(readRouteThroughPxpipe(undefined)).toBe(false);
  });
});

describe("pxpipeRoutingActive", () => {
  const ownBaseUrl = [
    { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
  ];

  it("is active only when the switch is on and nothing overrides the base URL", () => {
    expect(pxpipeRoutingActive({ routeThroughPxpipe: true }, [])).toBe(true);
    expect(pxpipeRoutingActive({ routeThroughPxpipe: true }, undefined)).toBe(true);
    expect(pxpipeRoutingActive({ routeThroughPxpipe: false }, [])).toBe(false);
  });

  // The instance card says "Routing inactive" for this case, so nothing else may
  // claim the sidecar's health decides its turns.
  it("is inactive when the instance sets its own base URL", () => {
    expect(pxpipeRoutingActive({ routeThroughPxpipe: true }, ownBaseUrl)).toBe(false);
  });
});
