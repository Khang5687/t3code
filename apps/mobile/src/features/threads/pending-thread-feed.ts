import type { OrchestrationQueuedTurn } from "@t3tools/contracts";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";

export type PendingThreadFeedEntry = ThreadFeedEntry & {
  readonly pendingMessage?: QueuedThreadMessage;
  readonly acknowledged?: boolean;
  /** A message the server holds until the running turn ends. */
  readonly queuedTurn?: OrchestrationQueuedTurn;
};

/**
 * Append the thread's server-side turn queue below the outbox. These are not
 * undelivered messages: the server has them and will start a turn for each one
 * as the turn before it ends.
 */
export function appendQueuedTurns(
  presentedFeed: ReadonlyArray<PendingThreadFeedEntry>,
  queuedTurns: ReadonlyArray<OrchestrationQueuedTurn>,
): ReadonlyArray<PendingThreadFeedEntry> {
  if (queuedTurns.length === 0) return presentedFeed;
  return [
    ...presentedFeed,
    ...queuedTurns.map((queuedTurn): PendingThreadFeedEntry => ({
      type: "message",
      id: `queued-turn:${queuedTurn.messageId}`,
      createdAt: queuedTurn.createdAt,
      queuedTurn,
      message: {
        id: queuedTurn.messageId,
        role: "user",
        text: queuedTurn.text,
        ...(queuedTurn.context !== undefined ? { context: queuedTurn.context } : {}),
        createdAt: queuedTurn.createdAt,
        updatedAt: queuedTurn.createdAt,
        turnId: null,
        streaming: false,
      },
    })),
  ];
}

/** Append the outbox after all presented activity, until the server echoes each message. */
export function appendPendingThreadMessages(
  presentedFeed: ReadonlyArray<ThreadFeedEntry>,
  feed: ReadonlyArray<ThreadFeedEntry>,
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
): ReadonlyArray<PendingThreadFeedEntry> {
  if (queuedMessages.length === 0) return presentedFeed;
  const deliveredIds = new Set(
    feed.flatMap((entry) => (entry.type === "message" ? [entry.message.id] : [])),
  );
  return [
    ...presentedFeed,
    ...queuedMessages
      .filter((message) => !deliveredIds.has(message.messageId))
      .map((pendingMessage): PendingThreadFeedEntry => ({
        type: "message",
        id: pendingMessage.messageId,
        createdAt: pendingMessage.createdAt,
        pendingMessage,
        message: {
          id: pendingMessage.messageId,
          role: "user",
          text: pendingMessage.text,
          context: pendingMessage.context,
          createdAt: pendingMessage.createdAt,
          updatedAt: pendingMessage.createdAt,
          turnId: null,
          streaming: false,
        },
      })),
  ];
}
