/**
 * Fork-only (ADR 0004). Pure pxpipe presentation shared by every client: how
 * the supervisor's status reads, whether an instance's opaque config opts into
 * routing, and why an instance that has the switch on is not actually routed.
 *
 * Lives here rather than beside a page because web (Settings → Sidecars →
 * pxpipe and Settings → Providers) and mobile (Settings → pxpipe) describe the
 * same sidecar and must not drift on the wording.
 */
import type { PxpipeSidecarState, SidecarEnvironmentVariable } from "@t3tools/contracts";

export interface PxpipeStatusDisplay {
  readonly label: string;
  /** Maps onto the dot's colour class; no client animates it. */
  readonly tone: "neutral" | "pending" | "good" | "warning" | "bad";
  readonly description: string;
}

const STATUS_DISPLAY: Readonly<Record<PxpipeSidecarState["status"], PxpipeStatusDisplay>> = {
  disabled: {
    label: "Off",
    tone: "neutral",
    description: "Settings say not to run pxpipe on this environment.",
  },
  stopped: {
    label: "Stopped",
    tone: "neutral",
    description: "pxpipe is configured to run, and a client stopped it.",
  },
  starting: {
    label: "Starting",
    tone: "pending",
    description: "pxpipe was spawned and has not answered a health check yet.",
  },
  healthy: { label: "Running", tone: "good", description: "pxpipe is answering health checks." },
  unhealthy: {
    label: "Unhealthy",
    tone: "warning",
    description: "pxpipe stopped answering. The supervisor is restarting it.",
  },
  failed: {
    label: "Failed",
    tone: "bad",
    description: "The supervisor gave up restarting pxpipe. Start it again to retry.",
  },
};

/**
 * An adopted sidecar is one the user started themselves. It reads as running
 * because it is, but T3 Code neither supervises nor stops it.
 */
export function describePxpipeStatus(state: PxpipeSidecarState | null): PxpipeStatusDisplay {
  if (state === null) {
    return { label: "Loading…", tone: "neutral", description: "" };
  }
  if (state.adopted) {
    return {
      label: "Running (started outside T3 Code)",
      tone: "good",
      description: "Something else already answers on this port, so T3 Code uses it as-is.",
    };
  }
  return STATUS_DISPLAY[state.status];
}

/**
 * `routeThroughPxpipe` rides in an instance's opaque config blob, which only
 * `ClaudeSettings` annotates. Read as a strict `true` so an instance saved
 * before the field existed, or one belonging to a driver that never had it,
 * reads as unrouted.
 */
export function readRouteThroughPxpipe(config: unknown): boolean {
  if (config === null || typeof config !== "object") return false;
  return (config as Record<string, unknown>).routeThroughPxpipe === true;
}

/**
 * Why routing is inactive on an instance that has the switch on, or null when
 * it is doing what it says. T3 Code never overrides a hand-set
 * `ANTHROPIC_BASE_URL` (ADR 0004), so the client has to say so — otherwise the
 * switch reads as on while every turn goes somewhere else.
 */
export function pxpipeRoutingOverride(
  routed: boolean,
  environment: ReadonlyArray<SidecarEnvironmentVariable> | undefined,
): string | null {
  if (!routed) return null;
  return setsOwnAnthropicBaseUrl(environment)
    ? "Routing is inactive: this instance sets ANTHROPIC_BASE_URL itself, and that value wins. Remove it under Environment to route through the sidecar."
    : null;
}

const setsOwnAnthropicBaseUrl = (
  environment: ReadonlyArray<SidecarEnvironmentVariable> | undefined,
): boolean => environment?.some((variable) => variable.name === "ANTHROPIC_BASE_URL") ?? false;

/**
 * Whether an instance's turns actually reach the sidecar: the switch is on and
 * nothing overrides where it points. `applyPxpipeRouting` on the server leaves a
 * hand-set `ANTHROPIC_BASE_URL` alone (ADR 0004), so the switch by itself does
 * not mean routed, and anything that speaks about the sidecar on behalf of an
 * instance — the trouble dot, the state poll — has to ask this instead. It sits
 * beside `pxpipeRoutingOverride` so the one override rule has one home.
 */
export function pxpipeRoutingActive(
  config: unknown,
  environment: ReadonlyArray<SidecarEnvironmentVariable> | undefined,
): boolean {
  return readRouteThroughPxpipe(config) && !setsOwnAnthropicBaseUrl(environment);
}
