import { LockIcon, LockOpenIcon, PlusIcon, XIcon } from "lucide-react";
import {
  DEFAULT_PXPIPE_SIDECAR_PORT,
  type PxpipeSidecarState,
  type ServerSettingsPatch,
  type SidecarEnvironmentVariable,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { RefreshIcon } from "../ui/refresh-icon";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  canRemovePxpipeCache,
  canStopPxpipe,
  describePxpipeStatus,
  formatModelAllowlist,
  parseModelAllowlist,
  publishableSidecarEnvironment,
  pxpipeBaseUrl,
  readPxpipeStats,
  type PxpipeStatusDisplay,
  type SidecarEnvironmentDraftRow,
} from "./PxpipeSidecarSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// A port reads as a raw number; grouping would show "47,821".
const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

type PxpipeSettingsPatch = NonNullable<NonNullable<ServerSettingsPatch["sidecars"]>["pxpipe"]>;

const TONE_DOT_CLASSNAME: Readonly<Record<PxpipeStatusDisplay["tone"], string>> = {
  neutral: "bg-muted-foreground/50",
  pending: "bg-warning/60",
  good: "bg-success",
  warning: "bg-warning",
  bad: "bg-destructive",
};

let sidecarEnvironmentDraftId = 0;
const nextSidecarEnvironmentDraftId = () => `sidecar-env-${sidecarEnvironmentDraftId++}`;

const toDraftRow = (
  variable: SidecarEnvironmentVariable,
  index: number,
): SidecarEnvironmentDraftRow => ({
  id: `${index}:${variable.name}`,
  name: variable.name,
  value: variable.value,
  sensitive: variable.sensitive,
  ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
});

/** `uptime_sec` is an age, so it reads through the same formatter as every other age. */
const formatUptime = (seconds: number): string =>
  formatElapsedDurationLabel(new Date(Date.now() - seconds * 1_000).toISOString());

const formatMegabytes = (bytes: number): string => `${Math.round(bytes / 1_048_576)} MB`;

const StatsFigure = ({ label, value }: { readonly label: string; readonly value: ReactNode }) => (
  <div className="min-w-0">
    <div className="text-xs text-muted-foreground">{label}</div>
    <div className="truncate text-sm tabular-nums text-foreground">{value ?? "—"}</div>
  </div>
);

/**
 * The extra-environment list, with the same sensitive-value treatment provider
 * instance environments get: a sensitive value is stored outside settings.json
 * and comes back as a redaction marker, so the field shows what to do rather
 * than a secret it was never given.
 */
function SidecarEnvironmentEditor({
  environment,
  onChange,
}: {
  readonly environment: ReadonlyArray<SidecarEnvironmentVariable>;
  readonly onChange: (next: ReadonlyArray<SidecarEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<SidecarEnvironmentDraftRow>>(() =>
    environment.map(toDraftRow),
  );
  // Settings echo back through the atom after every publish. Only a change that
  // did not come from this editor should blow away what the user is typing.
  const publishedRef = useRef<ReadonlyArray<SidecarEnvironmentVariable> | null>(null);
  useEffect(() => {
    if (publishedRef.current !== null && publishedRef.current.length === environment.length) {
      publishedRef.current = null;
      return;
    }
    publishedRef.current = null;
    setRows(environment.map(toDraftRow));
  }, [environment]);

  const publish = (nextRows: ReadonlyArray<SidecarEnvironmentDraftRow>) => {
    setRows(nextRows);
    const published = publishableSidecarEnvironment(nextRows);
    if (published === null) return;
    publishedRef.current = published;
    onChange(published);
  };

  const update = (id: string, patch: Partial<Omit<SidecarEnvironmentDraftRow, "id">>) =>
    publish(
      rows.map((row) =>
        row.id === id
          ? { ...row, ...patch, ...(patch.value !== undefined ? { valueRedacted: false } : {}) }
          : row,
      ),
    );

  return (
    <div className="mt-3 min-w-0 space-y-2 pb-2">
      {rows.map((variable, index) => (
        <div key={variable.id} className="flex min-w-0 items-center gap-1.5">
          <DraftInput
            size="sm"
            className="w-44 shrink-0 font-mono"
            value={variable.name}
            onCommit={(name) => update(variable.id, { name: name.trim() })}
            placeholder="VARIABLE_NAME"
            spellCheck={false}
            aria-label={`Sidecar environment variable name ${index + 1}`}
          />
          <span className="text-xs text-muted-foreground" aria-hidden>
            =
          </span>
          <DraftInput
            size="sm"
            className="min-w-0 flex-1 font-mono"
            value={variable.valueRedacted ? "" : variable.value}
            onCommit={(value) => update(variable.id, { value })}
            type={variable.sensitive ? "password" : undefined}
            autoComplete="off"
            placeholder={
              variable.valueRedacted ? "Stored secret, enter a new value to replace" : "value"
            }
            spellCheck={false}
            aria-label={`Sidecar environment variable value ${index + 1}`}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className={cn(
                    "[--control-icon-color:currentColor]",
                    variable.sensitive && "text-foreground",
                  )}
                  onClick={() => {
                    const sensitive = !variable.sensitive;
                    update(variable.id, {
                      sensitive,
                      ...(sensitive && variable.valueRedacted === undefined
                        ? {}
                        : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                    });
                  }}
                  aria-pressed={variable.sensitive}
                  aria-label={`Mark sidecar environment variable ${variable.name || index + 1} as sensitive`}
                >
                  {variable.sensitive ? (
                    <LockIcon className="size-3" />
                  ) : (
                    <LockOpenIcon className="size-3" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="top">
              {variable.sensitive ? "Sensitive, stored separately" : "Plain text"}
            </TooltipPopup>
          </Tooltip>
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            className="[--control-icon-color:currentColor] hover:text-destructive"
            onClick={() => publish(rows.filter((row) => row.id !== variable.id))}
            aria-label={`Remove sidecar environment variable ${variable.name || index + 1}`}
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ))}
      <div className="flex min-h-[1.875rem] flex-wrap items-center justify-end gap-x-3 gap-y-1">
        {rows.length > 0 ? (
          <span className="mr-auto text-xs text-muted-foreground">
            Sensitive values are stored separately and never returned to the app.
          </span>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          onClick={() =>
            setRows([
              ...rows,
              { id: nextSidecarEnvironmentDraftId(), name: "", value: "", sensitive: true },
            ])
          }
        >
          <PlusIcon className="size-3" />
          Add variable
        </Button>
      </div>
    </div>
  );
}

/**
 * Fork-only (ADR 0004). Settings → Sidecars → pxpipe: the environment's pxpipe
 * proxy, its configuration, the stats the proxy reports about itself, and the
 * cached install. Everything here is the environment's, not this client's, so a
 * remote browser sees the machine doing the work.
 *
 * The supervisor broadcasts nothing, so status polls while the page is mounted
 * (`serverEnvironment.sidecarPxpipeState`) and stats only refresh on mount and
 * on the refresh control. Nothing on the page animates.
 */
export function PxpipeSidecarSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const settings = usePrimarySettings((current) => current.sidecars.pxpipe);
  const updateSettings = useUpdatePrimarySettings();
  const patchPxpipe = useCallback(
    (pxpipe: PxpipeSettingsPatch) => updateSettings({ sidecars: { pxpipe } }),
    [updateSettings],
  );

  const stateQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.sidecarPxpipeState({ environmentId, input: {} }),
  );
  const statsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.sidecarPxpipeStats({ environmentId, input: {} }),
  );
  const setRunning = useAtomCommand(serverEnvironment.setSidecarPxpipeRunning, {
    reportFailure: false,
  });
  const removeCache = useAtomCommand(serverEnvironment.removeSidecarPxpipeCache, {
    reportFailure: false,
  });
  const [isBusy, setIsBusy] = useState(false);

  const state: PxpipeSidecarState | null = stateQuery.data;
  const status = describePxpipeStatus(state);
  const stats = readPxpipeStats(statsQuery.data);
  const refreshState = stateQuery.refresh;

  const run = async (
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    failureTitle: string,
  ): Promise<void> => {
    setIsBusy(true);
    try {
      const result = await action();
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      setIsBusy(false);
      refreshState();
    }
  };

  const canStop = canStopPxpipe(state);

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("sidecar-pxpipe")}
        description="A local proxy that compresses what T3 Code sends to the Anthropic Messages API. It rewrites request bodies, so routed instances can lose Claude prompt-cache hits and pay full price for a turn they would otherwise have read from cache."
      >
        <SettingsRow
          title="Status"
          description={status.description}
          status={
            <>
              {state === null ? null : (
                <>
                  <span className="block">
                    {state.version ? `pxpipe-proxy ${state.version}` : "No managed install"} ·{" "}
                    <span className="font-mono">{pxpipeBaseUrl(state.port)}</span>
                  </span>
                  <span className="block">
                    {state.pid === null ? "No supervised process" : `pid ${state.pid}`}
                    {state.restartCount > 0 ? ` · ${state.restartCount} restarts` : ""}
                  </span>
                  {state.lastError ? (
                    <span className="block text-destructive">{state.lastError}</span>
                  ) : null}
                </>
              )}
              {stateQuery.error ? (
                <span className="block text-destructive">{stateQuery.error}</span>
              ) : null}
            </>
          }
          control={
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-full", TONE_DOT_CLASSNAME[status.tone])}
              />
              <span className="text-[13px] text-muted-foreground">{status.label}</span>
              {canStop ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isBusy || environmentId === null}
                  onClick={() => {
                    if (environmentId === null) return;
                    void run(
                      () => setRunning({ environmentId, input: { running: false } }),
                      "Could not stop pxpipe",
                    );
                  }}
                >
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isBusy || environmentId === null || state?.adopted === true}
                  onClick={() => {
                    if (environmentId === null) return;
                    void run(
                      () => setRunning({ environmentId, input: { running: true } }),
                      "Could not start pxpipe",
                    );
                  }}
                >
                  Start
                </Button>
              )}
            </div>
          }
        />
        <SettingsRow
          title="Run the pxpipe sidecar"
          description="Start pxpipe with this environment's server and supervise it."
          serverScoped
          control={
            <Switch
              checked={settings.enabled}
              onCheckedChange={(enabled) => patchPxpipe({ enabled })}
              aria-label="Run the pxpipe sidecar"
            />
          }
        />
        <SettingsRow
          title="Port"
          description="Loopback port pxpipe listens on."
          serverScoped
          control={
            <NumberField
              value={settings.port}
              min={1}
              max={65535}
              format={NO_GROUPING}
              size="sm"
              className="w-28"
              onValueCommitted={(value) =>
                patchPxpipe({ port: value ?? DEFAULT_PXPIPE_SIDECAR_PORT })
              }
            >
              <NumberFieldGroup>
                <NumberFieldInput aria-label="pxpipe port" />
              </NumberFieldGroup>
            </NumberField>
          }
        />
        <SettingsRow
          title="Imaging models"
          description="Models pxpipe renders images for, comma separated. An empty list keeps pxpipe's own default; a single entry of off runs the proxy with imaging disabled."
          serverScoped
          control={
            <DraftInput
              size="sm"
              className="w-full font-mono sm:w-72"
              value={formatModelAllowlist(settings.models)}
              onCommit={(text) => patchPxpipe({ models: parseModelAllowlist(text) })}
              placeholder="pxpipe default"
              spellCheck={false}
              aria-label="Imaging models"
            />
          }
        />
        <SettingsRow
          title="Anthropic upstream"
          description="Where pxpipe forwards requests. Empty uses https://api.anthropic.com."
          serverScoped
          control={
            <DraftInput
              size="sm"
              className="w-full font-mono sm:w-72"
              value={settings.anthropicUpstream}
              onCommit={(anthropicUpstream) => patchPxpipe({ anthropicUpstream })}
              placeholder="https://api.anthropic.com"
              spellCheck={false}
              aria-label="Anthropic upstream"
            />
          }
        />
        <SettingsRow
          title="Log path"
          description="Where pxpipe writes its log, on the environment's filesystem. Empty leaves pxpipe's default."
          serverScoped
          control={
            <DraftInput
              size="sm"
              className="w-full font-mono sm:w-72"
              value={settings.logPath}
              onCommit={(logPath) => patchPxpipe({ logPath })}
              placeholder="pxpipe default"
              spellCheck={false}
              aria-label="Log path"
            />
          }
        />
        <SettingsRow
          title="Binary path"
          description="Run a pxpipe already installed on the environment's machine instead of the pinned one. Empty uses the managed install."
          serverScoped
          control={
            <DraftInput
              size="sm"
              className="w-full font-mono sm:w-72"
              value={settings.binaryPath}
              onCommit={(binaryPath) => patchPxpipe({ binaryPath })}
              placeholder="Managed install"
              spellCheck={false}
              aria-label="Binary path"
            />
          }
        />
        <SettingsRow
          title="Extra environment"
          description="Passed to pxpipe verbatim, for knobs without a control of their own."
          serverScoped
        >
          <SidecarEnvironmentEditor
            environment={settings.extraEnv}
            onChange={(extraEnv) => patchPxpipe({ extraEnv })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        id="sidecar-pxpipe-stats"
        title="Savings"
        description="What pxpipe reports about itself, read from the proxy when this page opens."
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh pxpipe stats"
            disabled={statsQuery.isPending || environmentId === null}
            onClick={() => statsQuery.refresh()}
          >
            <RefreshIcon className="size-3.5" />
          </Button>
        }
      >
        <SettingsRow
          title="Proxy stats"
          description={
            stats === null
              ? "Nothing is answering on the proxy port yet."
              : stats.compressionEnabled === false
                ? "Compression is off, so pxpipe is passing requests through."
                : undefined
          }
          status={
            statsQuery.error ? (
              <span className="block text-destructive">{statsQuery.error}</span>
            ) : null
          }
        >
          {stats === null ? null : (
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 pt-1 pb-3 sm:grid-cols-3">
              <StatsFigure label="Requests" value={stats.requests?.toLocaleString()} />
              <StatsFigure label="Compressed" value={stats.compressedRequests?.toLocaleString()} />
              <StatsFigure
                label="Input saved"
                value={stats.savedPercent === null ? null : `${stats.savedPercent}%`}
              />
              <StatsFigure
                label="Estimated saving"
                value={stats.savedUsd === null ? null : `$${stats.savedUsd.toFixed(2)}`}
              />
              <StatsFigure
                label="Uptime"
                value={stats.uptimeSeconds === null ? null : formatUptime(stats.uptimeSeconds)}
              />
              <StatsFigure
                label="Render cache"
                value={
                  stats.renderCache === null
                    ? null
                    : `${stats.renderCache.entries ?? "—"} entries${
                        stats.renderCache.bytes === null
                          ? ""
                          : `, ${formatMegabytes(stats.renderCache.bytes)}`
                      }`
                }
              />
            </div>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        id="sidecar-pxpipe-cache"
        title="Cached install"
        description="T3 Code installs the pinned pxpipe into this environment's T3 home and runs it from there."
      >
        <SettingsRow
          title="Version cache"
          description={
            state?.version
              ? `pxpipe-proxy ${state.version}, under sidecars/pxpipe/${state.version} in this environment's T3 home.`
              : "Nothing installed yet. The next start installs the pinned version."
          }
          status={
            canRemovePxpipeCache(state) ? null : (
              <span className="block">Stop the sidecar before removing its cached installs.</span>
            )
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={isBusy || environmentId === null || !canRemovePxpipeCache(state)}
              onClick={() => {
                if (environmentId === null) return;
                void run(
                  () => removeCache({ environmentId, input: {} }),
                  "Could not remove the pxpipe cache",
                );
              }}
            >
              Remove
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
