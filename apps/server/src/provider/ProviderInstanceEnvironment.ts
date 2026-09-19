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
 * An explicit value wins, from the instance's own environment list (already
 * merged into `env`) or inherited by the child (`inheritedEnv`), for the same
 * reason routing yields to a hand-set `ANTHROPIC_BASE_URL`.
 */
export function applyClaudeFirstPartyGates(
  env: NodeJS.ProcessEnv,
  allowed: boolean,
  inheritedEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  if (allowed) return env;
  if (
    env[ENABLE_CLAUDEAI_MCP_SERVERS] !== undefined ||
    inheritedEnv[ENABLE_CLAUDEAI_MCP_SERVERS] !== undefined
  ) {
    return env;
  }
  return { ...env, [ENABLE_CLAUDEAI_MCP_SERVERS]: "0" };
}
