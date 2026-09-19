import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  applyClaudeFirstPartyGates,
  applyPxpipeRouting,
  mergeProviderInstanceEnvironment,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join(NodeOS.homedir(), tail),
        CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("leaves inherited provider homes unchanged", () => {
    const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
        baseEnv,
      ),
    ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
  });

  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});

describe("applyPxpipeRouting", () => {
  it("leaves an unrouted instance untouched", () => {
    const env = { PATH: "/bin" };

    expect(applyPxpipeRouting(env, null)).toBe(env);
  });

  it("points a routed instance at the sidecar port", () => {
    expect(applyPxpipeRouting({ PATH: "/bin" }, 47821)).toEqual({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:47821",
    });
  });

  it("keeps a base URL the instance sets by hand", () => {
    const env = { ANTHROPIC_BASE_URL: "https://openrouter.ai/api" };

    expect(applyPxpipeRouting(env, 47821)).toBe(env);
  });

  it("keeps a base URL the child inherits from the server process", () => {
    const env = { PATH: "/bin" };

    expect(applyPxpipeRouting(env, 47821, { ANTHROPIC_BASE_URL: "https://proxy.internal" })).toBe(
      env,
    );
  });

  it("reads an empty hand-set value as set, because the child sees it either way", () => {
    const env = { ANTHROPIC_BASE_URL: "" };

    expect(applyPxpipeRouting(env, 47821)).toBe(env);
  });
});

describe("applyClaudeFirstPartyGates", () => {
  it("closes the connectors gate on an instance that has not opted in", () => {
    expect(applyClaudeFirstPartyGates({ PATH: "/bin" }, false)).toEqual({
      PATH: "/bin",
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
    });
  });

  it("leaves an opted-in instance untouched", () => {
    const env = { PATH: "/bin" };

    expect(applyClaudeFirstPartyGates(env, true)).toBe(env);
  });

  it("keeps a value the instance sets by hand", () => {
    const env = { ENABLE_CLAUDEAI_MCP_SERVERS: "1" };

    expect(applyClaudeFirstPartyGates(env, false)).toBe(env);
  });

  it("keeps a value the child inherits from the server process", () => {
    const env = { PATH: "/bin" };

    expect(applyClaudeFirstPartyGates(env, false, { ENABLE_CLAUDEAI_MCP_SERVERS: "1" })).toBe(env);
  });

  it("gates a routed instance too, so the two rules compose", () => {
    expect(applyClaudeFirstPartyGates(applyPxpipeRouting({ PATH: "/bin" }, 47821), false)).toEqual({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:47821",
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
    });
  });

  it("leaves an opted-in routed instance to pxpipe, which closes both gates anyway", () => {
    expect(applyClaudeFirstPartyGates(applyPxpipeRouting({ PATH: "/bin" }, 47821), true)).toEqual({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:47821",
    });
  });
});
