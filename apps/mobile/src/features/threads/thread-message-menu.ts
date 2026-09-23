import type { MenuAction } from "@react-native-menu/menu";
import { resolveForkTarget } from "@t3tools/client-runtime/thread-fork";
import { formatTimelineDebugRef } from "@t3tools/client-runtime/timeline-debug-ref";
import type {
  ChatAttachment,
  MessageId,
  OrchestrationMessage,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import type { PendingThreadFeedEntry } from "./pending-thread-feed";

/**
 * The long-press menu on a thread feed row. Every message-level action lives
 * here, so adding one is a change to `threadMessageMenuActions` rather than a
 * second gesture on the row.
 */

export type ThreadForkLocation = "same-workspace" | "new-worktree";

/** The boundary message: its text and attachments become the fork's draft. */
export interface ForkSourceMessage {
  readonly id: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface ThreadMessageMenu {
  /** The thread's provider supports conversation rollback (web's fork gate). */
  readonly forkSupported: boolean;
  /** `newWorktreeForkMessageIds` for the thread. */
  readonly newWorktreeMessageIds: ReadonlySet<MessageId>;
  readonly onFork: (message: ForkSourceMessage, location: ThreadForkLocation) => void;
}

const FORK_ACTION_ID = "fork";
const COPY_MESSAGE_ID_ACTION_ID = "copy-message-id";
const COPY_DEBUG_REF_ACTION_ID = "copy-debug-ref";
const FORK_LOCATION_ACTION_IDS: Readonly<Record<ThreadForkLocation, string>> = {
  "same-workspace": "fork:same-workspace",
  "new-worktree": "fork:new-worktree",
};

/**
 * Which fork location a pressed menu action id asks for. A flat "Fork from
 * here" carries the only eligible location, so it maps too.
 */
export function threadForkLocationFromActionId(actionId: string): ThreadForkLocation | null {
  if (actionId === FORK_ACTION_ID) return "same-workspace";
  if (actionId === FORK_LOCATION_ACTION_IDS["same-workspace"]) return "same-workspace";
  if (actionId === FORK_LOCATION_ACTION_IDS["new-worktree"]) return "new-worktree";
  return null;
}

type RollbackProvider = Pick<ServerProvider, "instanceId" | "supportsConversationRollback">;

/**
 * The visibility gate web uses for "Edit from here", read from the same
 * fields: the provider the thread's session runs on, falling back to the
 * provider its model selection points at. An unknown provider gates the
 * action off.
 */
export function threadSupportsConversationRollback(input: {
  readonly providers: ReadonlyArray<RollbackProvider>;
  readonly sessionProviderInstanceId: ProviderInstanceId | null;
  readonly modelInstanceId: ProviderInstanceId | null;
}): boolean {
  const provider =
    input.providers.find(
      (candidate) =>
        input.sessionProviderInstanceId !== null &&
        candidate.instanceId === input.sessionProviderInstanceId,
    ) ??
    input.providers.find(
      (candidate) =>
        input.modelInstanceId !== null && candidate.instanceId === input.modelInstanceId,
    ) ??
    null;
  return provider !== null && provider.supportsConversationRollback !== false;
}

/**
 * The user messages that offer "Fork into new worktree", decided per message
 * by the same `resolveForkTarget` web runs on press. The menu is built before
 * the press here, so the whole thread is resolved up front.
 */
export function newWorktreeForkMessageIds(
  input: Omit<Parameters<typeof resolveForkTarget>[0], "messageId">,
): ReadonlySet<MessageId> {
  const ids = new Set<MessageId>();
  if (!input.isGitProject) return ids;
  // ponytail: O(user messages x messages) per call; fold into one pass over
  // the thread if long threads show up in profiles.
  for (const message of input.messages) {
    if (message.role !== "user") continue;
    if (resolveForkTarget({ ...input, messageId: message.id })?.canForkIntoNewWorktree) {
      ids.add(message.id);
    }
  }
  return ids;
}

/**
 * The id the server recorded for a row, or null while the row is only local —
 * queued, waiting in the outbox, or still streaming. Fork needs a boundary the
 * server can resolve, so a local row offers no action that names a message.
 */
export function persistedMessageId(entry: PendingThreadFeedEntry): MessageId | null {
  if (entry.type !== "message") return null;
  if (entry.queuedTurn !== undefined) return null;
  if (entry.pendingMessage !== undefined && entry.acknowledged !== true) return null;
  return entry.message.streaming ? null : entry.message.id;
}

/** Mobile's half of web's `TimelineRowRecordRef`, over the feed's row model. */
export interface TimelineRowRecordRef {
  /** The id the server recorded for this row: a message id or an activity id. */
  readonly recordId: string;
  readonly turnId: TurnId | null;
}

/**
 * The single persisted record a row stands for, which is what the copy-ID
 * items name. A row standing for several records (an expanded tool group) or
 * for none (a turn fold, a work toggle, the live thinking slot) resolves to
 * null, so the menu never copies an ambiguous or client-only id. Web draws
 * the same line in `timelineRowRecordRef`, but there expanding a group splits
 * it into per-entry rows that each carry a ref; here the expanded group stays
 * one row, so its entries' ids remain out of reach.
 */
export function timelineRowRecordRef(entry: PendingThreadFeedEntry): TimelineRowRecordRef | null {
  if (entry.type === "message") {
    const recordId = persistedMessageId(entry);
    return recordId === null ? null : { recordId, turnId: entry.message.turnId };
  }
  if (entry.type === "agent-spawn") return { recordId: entry.activity.id, turnId: entry.turnId };
  if (entry.type === "activity-group" && entry.activities.length === 1) {
    return { recordId: entry.activities[0]!.id, turnId: entry.turnId };
  }
  return null;
}

/**
 * What a pressed copy action puts on the clipboard, and the `target` label a
 * failed clipboard write logs itself against. Other ids pass through as null.
 */
export function threadMessageCopyAction(
  actionId: string,
  row: { readonly threadId: ThreadId; readonly record: TimelineRowRecordRef },
): { readonly text: string; readonly target: string } | null {
  if (actionId === COPY_MESSAGE_ID_ACTION_ID) {
    return { text: row.record.recordId, target: "timeline-row-id" };
  }
  if (actionId === COPY_DEBUG_REF_ACTION_ID) {
    return {
      text: formatTimelineDebugRef({
        threadId: String(row.threadId),
        turnId: row.record.turnId,
        messageId: row.record.recordId,
      }),
      target: "timeline-row-debug-ref",
    };
  }
  return null;
}

export interface ThreadMessageMenuInput {
  readonly row: {
    /** Null on a row that is not a message, such as a tool activity. */
    readonly role: OrchestrationMessage["role"] | null;
    readonly persistedMessageId: MessageId | null;
    /** `timelineRowRecordRef` for this row. */
    readonly record: TimelineRowRecordRef | null;
  };
  /** The thread's provider supports conversation rollback. */
  readonly forkSupported: boolean;
  /** This row's message is in `newWorktreeForkMessageIds`. */
  readonly newWorktreeEligible: boolean;
}

/**
 * The actions a feed row offers on long press. An empty list means the row
 * gets no menu at all — callers render the row bare rather than opening an
 * empty sheet. Fork stays user-message-only; the copy items ride on any row
 * the server has recorded. One eligible fork location stays a flat action;
 * two open a submenu to choose between them.
 */
export function threadMessageMenuActions(input: ThreadMessageMenuInput): MenuAction[] {
  return [
    ...forkActions(input),
    ...(input.row.record === null
      ? []
      : [
          { id: COPY_MESSAGE_ID_ACTION_ID, title: "Copy message ID", image: "doc.on.doc" },
          { id: COPY_DEBUG_REF_ACTION_ID, title: "Copy debug ref", image: "ladybug" },
        ]),
  ];
}

function forkActions(input: ThreadMessageMenuInput): MenuAction[] {
  if (!input.forkSupported || input.row.role !== "user" || input.row.persistedMessageId === null) {
    return [];
  }
  const fork = { id: FORK_ACTION_ID, title: "Fork from here", image: "arrow.triangle.branch" };
  return input.newWorktreeEligible
    ? [
        {
          ...fork,
          subactions: [
            {
              id: FORK_LOCATION_ACTION_IDS["same-workspace"],
              title: "Fork in same workspace",
              image: "bubble.left.and.bubble.right",
            },
            {
              id: FORK_LOCATION_ACTION_IDS["new-worktree"],
              title: "Fork into new worktree",
              image: "folder.badge.plus",
            },
          ],
        },
      ]
    : [fork];
}
