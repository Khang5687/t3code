import type {
  PxpipeProxyStats,
  PxpipeSidecarState,
  SidecarEnvironmentVariable,
} from "@t3tools/contracts";

import type { ProviderStatusKey } from "./providerStatus";

/**
 * Fork-only (ADR 0004). Pure parts of the pxpipe UI: what the status reads as,
 * which controls the current state allows, how the proxy's own stats body is
 * narrowed, and what a routed provider instance shows when the sidecar is in
 * trouble. Shared by Settings → Sidecars → pxpipe and the provider cards under
 * Settings → Providers, which speak about the same sidecar.
 */

export interface PxpipeStatusDisplay {
  readonly label: string;
  /** Maps onto the dot's colour class; the page never animates it. */
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

export interface PxpipeRoutingTrouble {
  /** Reuses the provider card's dot palette, so one card speaks one language. */
  readonly statusKey: ProviderStatusKey;
  readonly detail: string;
}

/**
 * The pxpipe dot on a provider instance card. Only a routed instance can be in
 * trouble over the sidecar, and only a sidecar that will not serve its turns
 * counts as trouble, so a healthy, adopted or still-starting sidecar draws no
 * dot and the dot always means "this instance's turns fail right now". An
 * unrouted instance never draws one, whatever the sidecar is doing.
 */
export function pxpipeRoutingTrouble(
  routed: boolean,
  state: PxpipeSidecarState | null,
): PxpipeRoutingTrouble | null {
  if (!routed || state === null) return null;
  const status = describePxpipeStatus(state);
  if (status.tone === "good" || status.tone === "pending") return null;
  return {
    statusKey: status.tone === "bad" ? "error" : "warning",
    detail: `Routed through pxpipe, which is ${status.label.toLowerCase()}. Check Settings → Sidecars → pxpipe.`,
  };
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

/** Phases with a process behind them, so Stop has something to stop. */
export function canStopPxpipe(state: PxpipeSidecarState | null): boolean {
  if (state === null || state.adopted) return false;
  return state.status === "starting" || state.status === "healthy" || state.status === "unhealthy";
}

/** The supervisor refuses to delete the install underneath a live process. */
export function canRemovePxpipeCache(state: PxpipeSidecarState | null): boolean {
  return state !== null && !canStopPxpipe(state) && !state.adopted;
}

/** Where a routed Claude instance would point. pxpipe binds loopback only. */
export function pxpipeBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Comma or whitespace separated, because the allowlist is short and typed inline. */
export function parseModelAllowlist(text: string): ReadonlyArray<string> {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function formatModelAllowlist(models: ReadonlyArray<string>): string {
  return models.join(", ");
}

export interface SidecarEnvironmentDraftRow {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
}

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Drafts the user is still typing must not reach settings: a row with a name
 * that is not yet a valid variable holds the whole list back, and a row that is
 * entirely blank is dropped. `null` means "nothing to publish yet".
 */
export function publishableSidecarEnvironment(
  rows: ReadonlyArray<SidecarEnvironmentDraftRow>,
): ReadonlyArray<SidecarEnvironmentVariable> | null {
  const published: Array<SidecarEnvironmentVariable> = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
      if (name.length > 0 || row.value.length > 0 || row.valueRedacted !== undefined) return null;
      continue;
    }
    const { id: _id, ...rest } = row;
    published.push({ ...rest, name });
  }
  return published;
}

export interface PxpipeRenderCacheView {
  readonly entries: number | null;
  readonly bytes: number | null;
  readonly hits: number | null;
  readonly misses: number | null;
}

export interface PxpipeStatsView {
  readonly requests: number | null;
  readonly compressedRequests: number | null;
  readonly savedPercent: number | null;
  readonly savedUsd: number | null;
  readonly uptimeSeconds: number | null;
  readonly compressionEnabled: boolean | null;
  readonly renderCache: PxpipeRenderCacheView | null;
}

const readNumber = (source: Record<string, unknown>, key: string): number | null => {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/**
 * pxpipe owns `/proxy-stats` and ships around 35 keys. Every key it might
 * rename, retype or drop in a patch release reads back as `null` rather than
 * blanking the card, which is why the contract keeps the body an open record.
 */
export function readPxpipeStats(stats: PxpipeProxyStats | null): PxpipeStatsView | null {
  if (stats === null) return null;
  const compressionEnabled = stats.compression_enabled;
  const renderCache = stats.render_cache;
  return {
    requests: readNumber(stats, "requests"),
    compressedRequests: readNumber(stats, "compressed_requests"),
    savedPercent: readNumber(stats, "saved_pct"),
    savedUsd: readNumber(stats, "saved_usd"),
    uptimeSeconds: readNumber(stats, "uptime_sec"),
    compressionEnabled: typeof compressionEnabled === "boolean" ? compressionEnabled : null,
    renderCache:
      renderCache !== null && typeof renderCache === "object" && !Array.isArray(renderCache)
        ? {
            entries: readNumber(renderCache as Record<string, unknown>, "entries"),
            bytes: readNumber(renderCache as Record<string, unknown>, "bytes"),
            hits: readNumber(renderCache as Record<string, unknown>, "hits"),
            misses: readNumber(renderCache as Record<string, unknown>, "misses"),
          }
        : null,
  };
}
