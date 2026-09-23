import { recallableComposerPrompt } from "@t3tools/client-runtime/composer-prompt-history";
import { assetUrlStateFromResult } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  afterForkAction,
  CommandId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadId,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef } from "react";
import { Alert } from "react-native";

import { downloadAttachmentForPreview } from "../../lib/attachmentDownload";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import {
  persistComposerAttachmentFile,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { assetEnvironment } from "../../state/assets";
import { mobilePreferencesAtom } from "../../state/preferences";
import { usePreparedConnection } from "../../state/session";
import { showGitActionResult } from "../../state/use-vcs-action-state";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { mergeComposerDraftContent } from "../../state/use-composer-drafts";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ForkSourceMessage, ThreadForkLocation } from "./thread-message-menu";

/** An attachment type this build knows how to copy bytes for. */
type CopyableAttachment = ChatImageAttachment | ChatFileAttachment;

function isCopyableAttachment(attachment: ChatAttachment): attachment is CopyableAttachment {
  return attachment.type === "image" || attachment.type === "file";
}

function draftAttachment(attachment: CopyableAttachment, fileUri: string): DraftComposerAttachment {
  const shared = {
    id: uuidv4(),
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    fileUri,
  };
  return attachment.type === "image"
    ? { ...shared, type: "image", previewUri: fileUri }
    : { ...shared, type: "file", ...(attachment.source ? { source: attachment.source } : {}) };
}

/**
 * Copy the boundary message's attachments into files the fork's composer owns.
 * The server's copies stay put: a draft attachment has to carry its own bytes
 * because the send path uploads them again under the fork's turn.
 */
async function rematerializeForkAttachments(input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly resolveUrl: (attachment: CopyableAttachment) => Promise<string | null>;
  readonly signal: AbortSignal;
}): Promise<{
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly failedCount: number;
}> {
  const attachments: DraftComposerAttachment[] = [];
  let failedCount = 0;
  for (const attachment of input.attachments.slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS)) {
    if (input.signal.aborted) break;
    if (!isCopyableAttachment(attachment)) {
      failedCount += 1;
      continue;
    }
    try {
      const url = await input.resolveUrl(attachment);
      if (url === null) {
        failedCount += 1;
        continue;
      }
      const cached = await downloadAttachmentForPreview({
        url,
        attachment: { name: attachment.name, mimeType: attachment.mimeType },
        signal: new AbortController().signal,
      });
      if (cached === null) {
        failedCount += 1;
        continue;
      }
      try {
        attachments.push(
          draftAttachment(
            attachment,
            await persistComposerAttachmentFile(cached.uri, attachment.name),
          ),
        );
      } finally {
        cached.dispose();
      }
    } catch (error) {
      console.warn("[fork] could not copy an attachment into the fork's draft", error);
      failedCount += 1;
    }
  }
  return { attachments, failedCount };
}

function attachmentFailureMessage(count: number): string {
  return count === 1
    ? "One attachment could not be added to the fork. Attach it again before sending."
    : `${count} attachments could not be added to the fork. Attach them again before sending.`;
}

/**
 * Branches the thread at a past user message. The source is never touched: the
 * fork is a new thread whose history stops before the message, and the message
 * itself lands in the fork's own composer draft.
 *
 * Settings → Thread behavior → After forking decides whether this lands in the
 * fork or stays on the source with a banner that opens it.
 */
export function useForkThreadFromMessage(input: {
  readonly environmentId: EnvironmentId | null;
  readonly sourceThreadId: ThreadId | null;
}) {
  const { environmentId, sourceThreadId } = input;
  const fork = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const { selectThread } = useAdaptiveWorkspaceLayout();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const afterFork = AsyncResult.isSuccess(preferences) ? preferences.value.afterFork : undefined;
  const inFlight = useRef(false);
  // Attachment copying outlives the navigation away from this screen, so the
  // downloads need a signal that actually fires when the screen unmounts.
  const downloads = useRef(new AbortController());
  useEffect(() => {
    const controller = downloads.current;
    return () => controller.abort();
  }, []);

  const resolveUrl = useCallback(
    async (attachment: CopyableAttachment) => {
      if (environmentId === null || httpBaseUrl === null) return null;
      const state = assetUrlStateFromResult(
        await createAssetUrl({
          environmentId,
          input: {
            resource: {
              _tag: "attachment",
              attachmentId: attachment.id,
              fileName: attachment.name,
              mimeType: attachment.mimeType,
            },
          },
        }),
        httpBaseUrl,
      );
      return state._tag === "Success" ? state.url : null;
    },
    [createAssetUrl, environmentId, httpBaseUrl],
  );

  return useCallback(
    async (message: ForkSourceMessage, location: ThreadForkLocation) => {
      if (inFlight.current || environmentId === null || sourceThreadId === null) return;
      inFlight.current = true;
      try {
        const metadata = makeTurnCommandMetadata();
        const forkThreadId = ThreadId.make(metadata.threadId);
        const result = await fork({
          environmentId,
          input: {
            threadId: forkThreadId,
            sourceThreadId,
            messageId: message.id,
            // A new-worktree fork lands at once; its checkout then reports
            // progress on the fork's own setup card.
            location,
            commandId: CommandId.make(metadata.commandId),
            createdAt: metadata.createdAt,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not fork thread",
            error instanceof Error ? error.message : "The server rejected the fork. Try again.",
          );
          return;
        }

        // Open the fork before its attachments are copied: the draft key is
        // deterministic and the composer reads the draft atom, so the text is
        // there on arrival and the files land underneath it. Waiting here
        // would strand the user on the source thread with no feedback.
        const draftKey = scopedThreadKey(environmentId, forkThreadId);
        await mergeComposerDraftContent(draftKey, {
          text: recallableComposerPrompt(message.text),
          attachments: [],
        });
        const openFork = () => selectThread({ environmentId, id: forkThreadId });
        if (afterForkAction(afterFork) === "navigate") {
          openFork();
        } else {
          // Mobile has no generic toast, so the git-action banner carries this:
          // it is the one non-modal notification the thread screen already
          // mounts, and tapping it is the way into the fork.
          showGitActionResult({
            type: "success",
            title: "Forked this thread",
            description: "Tap to open the fork",
            onPress: openFork,
          });
        }
        if (message.attachments.length === 0) return;

        const copied = await rematerializeForkAttachments({
          attachments: message.attachments,
          resolveUrl,
          signal: downloads.current.signal,
        });
        const merged = await mergeComposerDraftContent(draftKey, {
          text: "",
          attachments: copied.attachments,
        });
        const lost = copied.failedCount + merged.skippedAttachmentCount;
        if (lost > 0) {
          Alert.alert("Some attachments were not copied", attachmentFailureMessage(lost));
        }
      } finally {
        inFlight.current = false;
      }
    },
    [afterFork, environmentId, fork, resolveUrl, selectThread, sourceThreadId],
  );
}
