import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return next;
}

/**
 * The variable a routed instance points at the sidecar. Exported because
 * whether an instance is really routed is decided by whether this is already
 * set, and the turn preflight has to reach the same verdict as the merge below.
 */
export const ANTHROPIC_BASE_URL = "ANTHROPIC_BASE_URL";

/**
 * Point a routed instance's environment at the pxpipe sidecar (ADR 0004), or
 * hand back the environment untouched when `port` is null. `port` carries both
 * halves of the decision — routed, and where to — so no caller re-derives one
 * without the other.
 *
 * Claude-shaped on purpose: pxpipe serves the Anthropic Messages API, so
 * routing is "not supported here" for Codex, Cursor, Grok, OpenCode and
 * Antigravity rather than a branch each adapter is missing.
 *
 * It lives here, next to the merge, rather than inside `makeClaudeEnvironment`:
 * the port comes from server settings, which the two places that assemble an
 * instance's environment already hold (`ClaudeDriver.create` for SDK sessions,
 * text generation and provider status; `resolveProviderInstanceTerminalEnvironment`
 * for T3 terminals) and which `makeClaudeEnvironment` does not.
 *
 * An explicit `ANTHROPIC_BASE_URL` always wins, whether it came from the
 * instance's own environment list (already merged into `env`) or from the
 * environment the child inherits underneath it (`inheritedEnv`, which the
 * terminal spawn layers below the resolved variables). A user who set that
 * value by hand meant it, and routing says so on the instance card.
 */
export function applyPxpipeRouting(
  env: NodeJS.ProcessEnv,
  port: number | null,
  inheritedEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  if (port === null) return env;
  if (env[ANTHROPIC_BASE_URL] !== undefined || inheritedEnv[ANTHROPIC_BASE_URL] !== undefined) {
    return env;
  }
  // pxpipe binds loopback only, and the sidecar runs on the same machine as
  // the provider process it serves.
  return { ...env, [ANTHROPIC_BASE_URL]: `http://127.0.0.1:${port}` };
}

/**
 * The one env var Claude Code reads to switch off auto-fetching claude.ai
 * connectors. It is named for enabling, and `"0"` is how you say no: the CLI
 * treats `0|false|no|off` as "disabled via env var".
 */
export const ENABLE_CLAUDEAI_MCP_SERVERS = "ENABLE_CLAUDEAI_MCP_SERVERS";

/**
 * Close Claude Code's first-party client gates for an instance that has not
 * opted into them, or hand the environment back untouched when it has.
 *
 * Fork-only, and deliberately the neighbour of `applyPxpipeRouting`: both
 * describe what a Claude instance's child processes are allowed to talk to,
 * and both have to reach every path an instance owns — SDK sessions, text
 * generation, the status and capabilities probes, and T3 terminals — or one
 * of them keeps the feature alive.
 *
 * Only connectors are reachable from here. Remote Control has no env switch;
 * the SDK sessions close it with the `managedSettings` policy tier in
 * `ClaudeAdapter`, and a `claude` the user starts by hand in a T3 terminal
 * still offers it unless the instance routes through pxpipe (ADR 0004) or the
 * user sets `disableRemoteControl` in their own Claude settings.
 *
 * Only a value from `configuredEnvironment` — the instance's own, user-authored
 * variable list — wins, and this is where the gate parts company with routing.
 * `env` is seeded from `process.env`, so reading the verdict off it would let
 * an `ENABLE_CLAUDEAI_MCP_SERVERS=1` that happened to be exported in the shell
 * that launched T3 Code silently open connectors on every Claude instance while
 * the card still says off. Nobody chose that per instance, so it does not win.
 * The instance's own entry is already merged into `env`, so returning `env`
 * untouched keeps the value the user asked for.
 */
export function applyClaudeFirstPartyGates(
  env: NodeJS.ProcessEnv,
  allowed: boolean,
  configuredEnvironment: ProviderInstanceEnvironment | undefined,
): NodeJS.ProcessEnv {
  if (allowed) return env;
  if (configuredEnvironment?.some((variable) => variable.name === ENABLE_CLAUDEAI_MCP_SERVERS)) {
    return env;
  }
  return { ...env, [ENABLE_CLAUDEAI_MCP_SERVERS]: "0" };
}

/**
 * Fork-only. What an instance without `firstPartyRemoteFeatures` sends as
 * Claude Code's policy tier, which outranks the user, project and local
 * settings a session also loads. Both keys survive the SDK's restrictive-only
 * filter.
 *
 * `managedSettings` in the SDK's `query()` options, `--managed-settings` on the
 * CLI: the same tier by two names, so SDK sessions, the capabilities probe and
 * text generation all say it. It lives here beside the connectors env var
 * because the two are halves of one gate — the env var is the only switch
 * Claude Code offers for connectors, and this is the only one for Remote
 * Control.
 *
 * It does not always land: see `claudeManagedSettings.ts` for the IT-managed
 * settings tier that outranks it.
 */
export const CLAUDE_FIRST_PARTY_LOCKDOWN = {
  disableRemoteControl: true,
  disableClaudeAiConnectors: true,
} as const;
