import { describePxpipeStatus } from "@t3tools/client-runtime/state/pxpipe";
import type {
  PxpipeProxyStats,
  PxpipeSidecarState,
  SidecarEnvironmentVariable,
} from "@t3tools/contracts";

import type { ProviderStatusKey } from "./providerStatus";

/**
 * Fork-only (ADR 0004). Web's own pxpipe UI logic: which controls the current
 * state allows, how the proxy's own stats body is narrowed, and what a routed
 * provider instance shows when the sidecar is in trouble. The parts every
 * client shares live in `@t3tools/client-runtime/state/pxpipe`.
 */

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
 *
 * `routed` must come from `pxpipeRoutingActive`, not from the switch alone: an
 * instance whose own `ANTHROPIC_BASE_URL` wins never reaches the sidecar, so a
 * dot there would contradict the card's own "Routing inactive" row.
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

/**
 * A name the user has committed that is not a variable name, so the row it is
 * on is holding the whole list back. The field says so through `aria-invalid`,
 * because the alternative is a list that silently stops saving.
 */
export function isInvalidSidecarEnvironmentName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !ENVIRONMENT_VARIABLE_NAME_PATTERN.test(trimmed);
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

/**
 * What the stats card says under its figures. pxpipe answers `/proxy-stats` for
 * whoever started it, so the page can hold real figures while the supervisor
 * reports the sidecar as down — a proxy the user runs themselves on the
 * configured port, or one the supervisor has given up on. A routed turn still
 * fails in that state, because the preflight wants `healthy`, so the figures
 * must not read as "routing works".
 */
export function describePxpipeStatsNote(
  state: PxpipeSidecarState | null,
  stats: PxpipeStatsView | null,
): string | null {
  if (stats === null) return "Nothing is answering on the proxy port yet.";
  if (state !== null) {
    const { tone } = describePxpipeStatus(state);
    if (tone !== "good" && tone !== "pending") {
      return "Something is answering on this port that T3 Code is not supervising, so these figures are not the sidecar's. Routed turns keep failing until the sidecar itself is running.";
    }
  }
  return stats.compressionEnabled === false
    ? "Compression is off, so pxpipe is passing requests through."
    : null;
}
