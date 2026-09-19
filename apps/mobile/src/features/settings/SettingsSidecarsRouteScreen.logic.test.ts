import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pxpipeRoutableInstances, pxpipeRoutingPatch } from "./SettingsSidecarsRouteScreen.logic";

const claudeDriver = ProviderDriverKind.make("claudeAgent");
const codexDriver = ProviderDriverKind.make("codex");
const defaultClaude = ProviderInstanceId.make("claudeAgent");
const workClaude = ProviderInstanceId.make("claude_work");
const defaultCodex = ProviderInstanceId.make("codex");

const settings = (overrides: Partial<ServerSettings> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  ...overrides,
});

const withLegacyRouting = (routed: boolean): ServerSettings =>
  settings({
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, routeThroughPxpipe: routed },
    },
  });

const instances = (map: Record<string, unknown>): ProviderInstanceConfigMap =>
  map as ProviderInstanceConfigMap;

describe("pxpipeRoutableInstances", () => {
  it("offers a switch for Claude instances only", () => {
    const rows = pxpipeRoutableInstances(
      [
        { instanceId: defaultClaude, driver: claudeDriver },
        { instanceId: defaultCodex, driver: codexDriver },
      ],
      settings(),
    );
    expect(rows.map((row) => row.instanceId)).toEqual([defaultClaude]);
  });

  it("reports each instance's first-party gates read-only, since a phone cannot flip them", () => {
    const rows = pxpipeRoutableInstances(
      [
        { instanceId: defaultClaude, driver: claudeDriver },
        { instanceId: workClaude, driver: claudeDriver },
      ],
      settings({
        providerInstances: instances({
          [workClaude]: { driver: claudeDriver, config: { firstPartyRemoteFeatures: true } },
        }),
      }),
    );

    expect(rows.map((row) => row.remoteFeaturesStatus)).toEqual([
      "Remote Control and claude.ai connectors: off",
      "Remote Control and claude.ai connectors: allowed",
    ]);
  });

  // The switch is on but a hand-set ANTHROPIC_BASE_URL wins, so none of what
  // routing would close is closed. Reading the switch instead of the verdict
  // made the row claim routing had already shut both gates.
  it("does not credit routing on an instance whose base URL overrides it", () => {
    const rows = pxpipeRoutableInstances(
      [{ instanceId: workClaude, driver: claudeDriver }],
      settings({
        providerInstances: instances({
          [workClaude]: {
            driver: claudeDriver,
            config: { routeThroughPxpipe: true, firstPartyRemoteFeatures: true },
            environment: [
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
          },
        }),
      }),
    );

    expect(rows[0]?.inactiveReason).toContain("Routing is inactive");
    expect(rows[0]?.remoteFeaturesStatus).toBe("Remote Control and claude.ai connectors: allowed");
  });

  it("passes the server's IT-managed settings verdict through to the status", () => {
    const rows = pxpipeRoutableInstances(
      [{ instanceId: defaultClaude, driver: claudeDriver, claudeManagedSettings: true }],
      settings(),
    );

    expect(rows[0]?.remoteFeaturesStatus).toContain("IT-managed Claude settings");
  });

  it("reads the legacy mirror for a default slot that has no instance entry", () => {
    const rows = pxpipeRoutableInstances(
      [{ instanceId: defaultClaude, driver: claudeDriver }],
      withLegacyRouting(true),
    );
    expect(rows[0]?.routed).toBe(true);
    expect(
      pxpipeRoutableInstances([{ instanceId: defaultClaude, driver: claudeDriver }], settings())[0]
        ?.routed,
    ).toBe(false);
  });

  it("lets an explicit instance entry win over the legacy mirror", () => {
    const rows = pxpipeRoutableInstances([{ instanceId: defaultClaude, driver: claudeDriver }], {
      ...withLegacyRouting(true),
      providerInstances: instances({
        claudeAgent: { driver: claudeDriver, config: { routeThroughPxpipe: false } },
      }),
    });
    expect(rows[0]?.routed).toBe(false);
  });

  it("never reads the legacy mirror for a non-default instance", () => {
    const rows = pxpipeRoutableInstances(
      [{ instanceId: workClaude, driver: claudeDriver }],
      withLegacyRouting(true),
    );
    expect(rows[0]?.routed).toBe(false);
  });

  it("labels an instance by its own name, then the driver's", () => {
    const rows = pxpipeRoutableInstances(
      [
        { instanceId: defaultClaude, driver: claudeDriver },
        { instanceId: workClaude, driver: claudeDriver, displayName: "Claude Work" },
      ],
      settings(),
    );
    expect(rows.map((row) => row.label)).toEqual(["Claude", "Claude Work"]);
  });

  it("says routing is inactive when the instance sets its own base URL", () => {
    const rows = pxpipeRoutableInstances([{ instanceId: workClaude, driver: claudeDriver }], {
      ...settings(),
      providerInstances: instances({
        claude_work: {
          driver: claudeDriver,
          config: { routeThroughPxpipe: true },
          environment: [
            { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
          ],
        },
      }),
    });
    expect(rows[0]?.routed).toBe(true);
    expect(rows[0]?.inactiveReason).toContain("ANTHROPIC_BASE_URL");
  });
});

describe("pxpipeRoutingPatch", () => {
  it("patches the legacy mirror for a default slot with no instance entry", () => {
    expect(pxpipeRoutingPatch(settings(), defaultClaude, true)).toEqual({
      providers: { claudeAgent: { routeThroughPxpipe: true } },
    });
  });

  it("replaces the whole instance map and keeps the rest of the config", () => {
    const current = {
      ...settings(),
      providerInstances: instances({
        claude_work: {
          driver: claudeDriver,
          displayName: "Claude Work",
          config: { binaryPath: "/usr/local/bin/claude", routeThroughPxpipe: false },
        },
        codex: { driver: codexDriver, config: {} },
      }),
    };
    expect(pxpipeRoutingPatch(current, workClaude, true)).toEqual({
      providerInstances: {
        claude_work: {
          driver: claudeDriver,
          displayName: "Claude Work",
          config: { binaryPath: "/usr/local/bin/claude", routeThroughPxpipe: true },
        },
        codex: { driver: codexDriver, config: {} },
      },
    });
  });

  it("refuses an instance that pxpipe cannot serve", () => {
    const current = {
      ...settings(),
      providerInstances: instances({ codex: { driver: codexDriver, config: {} } }),
    };
    expect(pxpipeRoutingPatch(current, defaultCodex, true)).toBeNull();
    // A non-default id with no entry has no legacy mirror to fall back on.
    expect(pxpipeRoutingPatch(settings(), workClaude, true)).toBeNull();
  });
});
