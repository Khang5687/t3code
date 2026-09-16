import { XIcon } from "lucide-react";
import {
  type ListenInterfaceKind,
  type ListenInterfaces,
  type DesktopBridge,
  type DesktopServerExposureState,
  type ExposurePreset,
  isIpv4Address,
  listenInterfacesEqual,
  listenInterfacesForPreset,
  normalizeListenInterfaces,
} from "@t3tools/contracts";
import { type ReactNode, useCallback, useId, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";
import { EXPOSURE_PRESET_OPTIONS, widensExposure } from "./ExposureSettings.logic";

const LISTEN_INTERFACE_LABELS: Record<ListenInterfaceKind, string> = {
  loopback: "Loopback",
  tailnet: "Tailnet",
  lan: "Local network",
};

const LISTEN_INTERFACE_KINDS = Object.keys(
  LISTEN_INTERFACE_LABELS,
) as ReadonlyArray<ListenInterfaceKind>;

/** What a selection opens, in the words the checkboxes use. */
const describeSelection = (selection: ListenInterfaces): string =>
  [...selection.kinds.map((kind) => LISTEN_INTERFACE_LABELS[kind]), ...selection.addresses].join(
    ", ",
  );

/**
 * Fork-only (ADR 0003). The Connections exposure control: a preset picker over
 * the environment's listen-interface selection, plus a custom panel for
 * interface kinds and explicit IPv4 addresses. Selection, preset, resolved
 * addresses and warnings all come from the desktop exposure state; this
 * component never derives a preset itself.
 *
 * Applying a selection relaunches the backend, so any change that opens a
 * non-loopback interface is confirmed first.
 */
export function ExposureSettingsRow({
  state,
  setListenInterfaces,
  onApplied,
  error,
  endpointSummary,
}: {
  readonly state: DesktopServerExposureState | null;
  readonly setListenInterfaces: DesktopBridge["setServerListenInterfaces"] | undefined;
  readonly onApplied: () => void;
  readonly error: string | null;
  readonly endpointSummary: ReactNode;
}) {
  const addressInputId = useId();
  const kindIdPrefix = useId();
  const [isCustomRevealed, setIsCustomRevealed] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<ListenInterfaces | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);

  const selection = state?.listenInterfaces ?? null;
  // The revealed panel is a view, not a pending change: picking Custom shows
  // the current selection's kinds until the user actually edits one.
  const preset: ExposurePreset =
    state === null ? "local-only" : isCustomRevealed ? "custom" : state.preset;

  const apply = useCallback(
    async (next: ListenInterfaces) => {
      if (!setListenInterfaces) return;
      setIsApplying(true);
      setMutationError(null);
      try {
        await setListenInterfaces(next);
        onApplied();
      } catch (cause) {
        setMutationError(cause instanceof Error ? cause.message : "Failed to update exposure.");
      } finally {
        setIsApplying(false);
        setPendingSelection(null);
      }
    },
    [onApplied, setListenInterfaces],
  );

  const request = useCallback(
    (next: ListenInterfaces) => {
      if (!selection || listenInterfacesEqual(selection, next)) return;
      if (widensExposure(selection, next)) {
        setPendingSelection(next);
        return;
      }
      void apply(next);
    },
    [apply, selection],
  );

  const handlePresetChange = useCallback(
    (value: ExposurePreset) => {
      if (value === "custom") {
        setIsCustomRevealed(true);
        return;
      }
      setIsCustomRevealed(false);
      request(listenInterfacesForPreset(value));
    },
    [request],
  );

  const handleKindToggle = useCallback(
    (kind: ListenInterfaceKind, selected: boolean) => {
      if (!selection) return;
      request(
        normalizeListenInterfaces({
          kinds: selected
            ? [...selection.kinds, kind]
            : selection.kinds.filter((current) => current !== kind),
          addresses: selection.addresses,
        }),
      );
    },
    [request, selection],
  );

  const handleAddAddress = useCallback(() => {
    if (!selection) return;
    const address = addressDraft.trim();
    if (address.length === 0) return;
    if (!isIpv4Address(address)) {
      setAddressError(`"${address}" is not an IPv4 address.`);
      return;
    }
    if (selection.addresses.includes(address)) {
      setAddressError(`${address} is already in the list.`);
      return;
    }
    setAddressError(null);
    setAddressDraft("");
    request(
      normalizeListenInterfaces({
        kinds: selection.kinds,
        addresses: [...selection.addresses, address],
      }),
    );
  }, [addressDraft, request, selection]);

  const handleRemoveAddress = useCallback(
    (address: string) => {
      if (!selection) return;
      request(
        normalizeListenInterfaces({
          kinds: selection.kinds,
          addresses: selection.addresses.filter((current) => current !== address),
        }),
      );
    },
    [request, selection],
  );

  const shownError = mutationError ?? error;
  const presetOption = EXPOSURE_PRESET_OPTIONS.find((option) => option.preset === preset);

  return (
    <>
      <SettingsRow
        title="Exposure"
        description={
          state === null ? (
            "Loading…"
          ) : (
            <>
              {presetOption?.description} {endpointSummary}
            </>
          )
        }
        status={
          <>
            {state ? (
              <>
                <span className="block">
                  Listening on{" "}
                  {state.resolvedAddresses.length > 0
                    ? state.resolvedAddresses.join(", ")
                    : "nothing yet"}
                </span>
                {state.warnings.map((warning) => (
                  <span className="block text-warning" key={warning}>
                    {warning}
                  </span>
                ))}
              </>
            ) : null}
            {shownError ? <span className="block text-destructive">{shownError}</span> : null}
          </>
        }
        control={
          <Select
            value={preset}
            onValueChange={(value) => {
              if (typeof value !== "string") return;
              handlePresetChange(value as ExposurePreset);
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-56"
              aria-label="Exposure preset"
              disabled={state === null || isApplying}
            >
              <SelectValue>{presetOption?.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {EXPOSURE_PRESET_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.preset} value={option.preset}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        {preset === "custom" && selection ? (
          <div className="space-y-3 pt-1 pb-3">
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {LISTEN_INTERFACE_KINDS.map((kind) => (
                <div className="flex items-center gap-2" key={kind}>
                  <Checkbox
                    checked={selection.kinds.includes(kind)}
                    // Loopback is always part of a selection, so it cannot be turned off.
                    disabled={kind === "loopback" || isApplying}
                    id={`${kindIdPrefix}-${kind}`}
                    onCheckedChange={(checked) => handleKindToggle(kind, checked)}
                  />
                  <label className="text-[13px]" htmlFor={`${kindIdPrefix}-${kind}`}>
                    {LISTEN_INTERFACE_LABELS[kind]}
                  </label>
                </div>
              ))}
            </div>
            {selection.addresses.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {selection.addresses.map((address) => (
                  <li
                    className="inline-flex items-center gap-1 rounded-md border border-border/60 py-0.5 pr-0.5 pl-2 font-mono text-xs"
                    key={address}
                  >
                    {address}
                    <Button
                      aria-label={`Remove ${address}`}
                      disabled={isApplying}
                      onClick={() => handleRemoveAddress(address)}
                      size="icon-micro"
                      variant="ghost-muted"
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-start gap-2">
              <Input
                aria-describedby={addressError ? `${addressInputId}-error` : undefined}
                aria-invalid={addressError ? true : undefined}
                aria-label="IPv4 address to listen on"
                className="w-full sm:w-56"
                disabled={isApplying}
                id={addressInputId}
                onChange={(event) => {
                  setAddressDraft(event.target.value);
                  setAddressError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  handleAddAddress();
                }}
                placeholder="192.168.1.10"
                size="sm"
                value={addressDraft}
              />
              <Button
                disabled={isApplying || addressDraft.trim().length === 0}
                onClick={handleAddAddress}
                size="sm"
                variant="outline"
              >
                Add address
              </Button>
              {addressError ? (
                <p className="w-full text-xs text-destructive" id={`${addressInputId}-error`}>
                  {addressError}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </SettingsRow>
      <AlertDialog
        open={pendingSelection !== null}
        onOpenChange={(open) => {
          if (isApplying || open) return;
          setPendingSelection(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Widen exposure?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingSelection
                ? `T3 Code restarts to listen on ${describeSelection(pendingSelection)}. Other devices that can reach those interfaces will be able to pair.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isApplying}
              render={<Button variant="outline" disabled={isApplying} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              disabled={isApplying}
              onClick={() => {
                if (pendingSelection) void apply(pendingSelection);
              }}
            >
              {isApplying ? (
                <>
                  <Spinner className="size-3.5" />
                  Restarting…
                </>
              ) : (
                "Restart and apply"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
