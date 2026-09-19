import { describe, expect, it } from "vite-plus/test";

import {
  claudeFirstPartyFeaturesNote,
  claudeFirstPartyFeaturesStatus,
  readFirstPartyRemoteFeatures,
} from "./claudeFirstParty.ts";

describe("readFirstPartyRemoteFeatures", () => {
  it.each([
    { config: { firstPartyRemoteFeatures: true }, expected: true },
    { config: { firstPartyRemoteFeatures: false }, expected: false },
    // An instance saved before the field existed, or a driver that never had it.
    { config: {}, expected: false },
    { config: { firstPartyRemoteFeatures: "true" }, expected: false },
    { config: null, expected: false },
    { config: undefined, expected: false },
  ])("reads $config as $expected", ({ config, expected }) => {
    expect(readFirstPartyRemoteFeatures(config)).toBe(expected);
  });
});

describe("claudeFirstPartyFeaturesNote", () => {
  it("says nothing extra when an unrouted instance has opted in", () => {
    expect(claudeFirstPartyFeaturesNote({ allowed: true, routedThroughPxpipe: false })).toBeNull();
  });

  it("warns that a routed instance keeps both closed whatever the switch says", () => {
    expect(claudeFirstPartyFeaturesNote({ allowed: true, routedThroughPxpipe: true })).toContain(
      "api.anthropic.com",
    );
  });

  it("stays quiet on a routed instance that also has the switch off", () => {
    expect(claudeFirstPartyFeaturesNote({ allowed: false, routedThroughPxpipe: true })).toBeNull();
  });

  it("names the gap a hand-started terminal `claude` still has", () => {
    expect(claudeFirstPartyFeaturesNote({ allowed: false, routedThroughPxpipe: false })).toContain(
      "disableRemoteControl",
    );
  });

  // Claude Code drops a spawning parent's policy tier whole when the machine
  // already has an IT-managed one, so the switch closes connectors (an env var)
  // and nothing else.
  it("says Remote Control is not refused on an IT-managed machine", () => {
    const note = claudeFirstPartyFeaturesNote({
      allowed: false,
      routedThroughPxpipe: false,
      managedSettingsPresent: true,
    });

    expect(note).toContain("IT-managed Claude settings file");
    expect(note).toContain("connectors are still off");
  });

  it("keeps the routed message on an IT-managed machine, where routing still closes both", () => {
    expect(
      claudeFirstPartyFeaturesNote({
        allowed: false,
        routedThroughPxpipe: true,
        managedSettingsPresent: true,
      }),
    ).toBeNull();
  });
});

describe("claudeFirstPartyFeaturesStatus", () => {
  it.each([
    { allowed: false, routedThroughPxpipe: false, expected: "off" },
    { allowed: true, routedThroughPxpipe: false, expected: "allowed" },
    { allowed: true, routedThroughPxpipe: true, expected: "off (routed)" },
  ])("reads allowed=$allowed routed=$routedThroughPxpipe as $expected", (input) => {
    expect(claudeFirstPartyFeaturesStatus(input)).toBe(
      `Remote Control and claude.ai connectors: ${input.expected}`,
    );
  });

  it("splits the two gates apart on an IT-managed machine", () => {
    expect(
      claudeFirstPartyFeaturesStatus({
        allowed: false,
        routedThroughPxpipe: false,
        managedSettingsPresent: true,
      }),
    ).toBe(
      "claude.ai connectors: off. Remote Control: not refused, this machine has IT-managed Claude settings",
    );
  });
});
