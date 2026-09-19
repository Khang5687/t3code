/**
 * Fork-only. Pure presentation for Claude Code's first-party remote features —
 * Remote Control and claude.ai connectors — shared by every client.
 *
 * Lives here rather than beside a page because web (Settings → Providers) and
 * mobile (Settings → pxpipe, read-only) describe the same gates and must not
 * drift on what is actually closed.
 */

/**
 * `firstPartyRemoteFeatures` rides in an instance's opaque config blob, which
 * only `ClaudeSettings` annotates. Read as a strict `true` so an instance saved
 * before the field existed, or one belonging to a driver that never had it,
 * reads as gated — which is the default the schema gives new instances too.
 */
export function readFirstPartyRemoteFeatures(config: unknown): boolean {
  if (config === null || typeof config !== "object") return false;
  return (config as Record<string, unknown>).firstPartyRemoteFeatures === true;
}

/**
 * What the instance card says under the switch, or null when the switch speaks
 * for itself.
 *
 * Two things the switch alone would misreport. Routing through pxpipe already
 * closes both gates by pointing ANTHROPIC_BASE_URL away from api.anthropic.com
 * (ADR 0004), so an instance with the switch on is not getting what it says.
 * And with the switch off, a `claude` the user starts by hand in a T3 terminal
 * still offers Remote Control: Claude Code has no environment variable for it,
 * so only the SDK sessions T3 Code spawns carry the policy that refuses it.
 */
export function claudeFirstPartyFeaturesNote(input: {
  readonly allowed: boolean;
  readonly routedThroughPxpipe: boolean;
}): string | null {
  if (input.routedThroughPxpipe) {
    return input.allowed
      ? "Both stay off while this instance routes through pxpipe: its traffic does not reach api.anthropic.com, which is what Claude Code checks."
      : null;
  }
  if (input.allowed) return null;
  return "Threads and text generation refuse both. A `claude` you start yourself in a terminal still offers Remote Control — Claude Code has no environment variable for it — so turn it off there with `disableRemoteControl` in your own Claude settings, or route this instance through pxpipe.";
}

/** The one-line status mobile shows where it cannot offer the switch. */
export function claudeFirstPartyFeaturesStatus(input: {
  readonly allowed: boolean;
  readonly routedThroughPxpipe: boolean;
}): string {
  if (input.routedThroughPxpipe) return "Remote Control and claude.ai connectors: off (routed)";
  return input.allowed
    ? "Remote Control and claude.ai connectors: allowed"
    : "Remote Control and claude.ai connectors: off";
}
