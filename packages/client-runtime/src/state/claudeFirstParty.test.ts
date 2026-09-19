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
});
