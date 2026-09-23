import { useRef, type KeyboardEvent, type MouseEvent } from "react";
import { HashIcon } from "lucide-react";
import { formatTimelineDebugRef } from "@t3tools/client-runtime/timeline-debug-ref";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { TimelineRowRecordRef } from "./MessagesTimeline.logic";

/**
 * Hover-revealed "copy this row's ID" affordance for rows backed by a
 * persisted record. Click copies the bare ID, shift-click copies the
 * one-line debug reference that locates the row in the event log. Renders
 * nothing when the row has no stable record (`recordRef` null), so a
 * streaming or client-only row never hands out a transient value.
 *
 * The caller owns the reveal: `className` lands on a plain wrapper, so a row
 * can pass the hover/focus classes its container already uses without
 * restyling the button itself.
 */
export function CopyTimelineRowIdButton({
  recordRef,
  threadId,
  size = "icon-micro",
  className,
}: {
  recordRef: TimelineRowRecordRef | null;
  threadId: string | null;
  size?: "xs" | "icon-micro";
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard } = useCopyToClipboard<void>({
    target: "row ID",
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });

  if (!recordRef) return null;

  const debugRef = threadId
    ? formatTimelineDebugRef({
        threadId,
        turnId: recordRef.turnId,
        messageId: recordRef.recordId,
      })
    : recordRef.recordId;

  return (
    <span className={cn("inline-flex shrink-0", className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Copy row ID"
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                // Work rows expand on click and on Enter/Space; copying must
                // not also toggle the row it sits in.
                event.stopPropagation();
                copyToClipboard(event.shiftKey ? debugRef : recordRef.recordId);
              }}
              onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}
              ref={ref}
              type="button"
              size={size}
              variant="ghost-muted"
            />
          }
        >
          <HashIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>
          <div className="grid grid-cols-[auto_1fr] gap-x-2 font-mono text-xs">
            {threadId ? (
              <>
                <span className="text-muted-foreground">thread</span>
                <span>{threadId}</span>
              </>
            ) : null}
            {recordRef.turnId ? (
              <>
                <span className="text-muted-foreground">turn</span>
                <span>{recordRef.turnId}</span>
              </>
            ) : null}
            <span className="text-muted-foreground">message</span>
            <span>{recordRef.recordId}</span>
          </div>
          <p className="mt-1 text-muted-foreground">click to copy · shift-click for debug ref</p>
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
