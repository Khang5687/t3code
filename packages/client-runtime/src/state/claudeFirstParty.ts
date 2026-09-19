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

export interface ClaudeFirstPartyFeaturesInput {
  readonly allowed: boolean;
  /**
   * Routed *and* actually routing. A hand-set ANTHROPIC_BASE_URL beats the
   * switch (`pxpipeRoutingOverride`), and an instance in that state gets none
   * of what routing would close — so callers pass the verdict, not the switch.
   */
  readonly routedThroughPxpipe: boolean;
  /**
   * `ServerProvider.claudeManagedSettings`: this machine has an IT-managed
   * Claude settings tier, so Claude Code drops the policy T3 Code sends.
   */
  readonly managedSettingsPresent?: boolean | undefined;
}

/**
 * What the instance card says under the switch, or null when the switch speaks
 * for itself.
 *
 * Three things the switch alone would misreport. Routing through pxpipe already
 * closes both gates by pointing ANTHROPIC_BASE_URL away from api.anthropic.com
 * (ADR 0004), so an instance with the switch on is not getting what it says.
 * With the switch off, a `claude` the user starts by hand in a T3 terminal
 * still offers Remote Control: Claude Code has no environment variable for it,
 * so only the SDK sessions T3 Code spawns carry the policy that refuses it. And
 * on a machine an administrator already governs, that policy is dropped before
 * it is read, which leaves Remote Control open on every path.
 */
export function claudeFirstPartyFeaturesNote(input: ClaudeFirstPartyFeaturesInput): string | null {
  if (input.routedThroughPxpipe) {
    return input.allowed
      ? "Both stay off while this instance routes through pxpipe: its traffic does not reach api.anthropic.com, which is what Claude Code checks."
      : null;
  }
  if (input.allowed) return null;
  if (input.managedSettingsPresent === true) {
    return "Remote Control is not being refused: this machine has an IT-managed Claude settings file, and Claude Code ignores the policy T3 Code sends when one exists. claude.ai connectors are still off. Ask whoever manages this machine to set `disableRemoteControl` there, or route this instance through pxpipe.";
  }
  return "Threads and text generation refuse both. A `claude` you start yourself in a terminal still offers Remote Control — Claude Code has no environment variable for it — so turn it off there with `disableRemoteControl` in your own Claude settings, or route this instance through pxpipe.";
}

/** The one-line status mobile shows where it cannot offer the switch. */
export function claudeFirstPartyFeaturesStatus(input: ClaudeFirstPartyFeaturesInput): string {
  if (input.routedThroughPxpipe) return "Remote Control and claude.ai connectors: off (routed)";
  if (input.allowed) return "Remote Control and claude.ai connectors: allowed";
  if (input.managedSettingsPresent === true) {
    return "claude.ai connectors: off. Remote Control: not refused, this machine has IT-managed Claude settings";
  }
  return "Remote Control and claude.ai connectors: off";
}
