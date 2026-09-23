import type {
  MessageId,
  OrchestrationQueuedTurn,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PendingThreadFeedEntry } from "./pending-thread-feed";
import {
  newWorktreeForkMessageIds,
  persistedMessageId,
  threadForkLocationFromActionId,
  threadMessageCopyAction,
  threadMessageMenuActions,
  threadSupportsConversationRollback,
  timelineRowRecordRef,
} from "./thread-message-menu";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";

const messageId = "message-1" as MessageId;
const threadId = "thread-1" as ThreadId;
const turnId = "turn-1" as TurnId;
const sessionInstance = "instance-session" as ProviderInstanceId;
const modelInstance = "instance-model" as ProviderInstanceId;

function provider(
  instanceId: ProviderInstanceId,
  supportsConversationRollback?: boolean,
): Pick<ServerProvider, "instanceId" | "supportsConversationRollback"> {
  return supportsConversationRollback === undefined
    ? { instanceId }
    : { instanceId, supportsConversationRollback };
}

function actionIds(actions: ReadonlyArray<{ readonly id?: string }>): ReadonlyArray<string> {
  return actions.map((action) => action.id ?? "");
}

function messageEntry(
  overrides: Partial<PendingThreadFeedEntry> & {
    readonly streaming?: boolean;
    readonly messageTurnId?: TurnId;
  } = {},
): PendingThreadFeedEntry {
  const { streaming = false, messageTurnId = null, ...rest } = overrides;
  return {
    type: "message",
    id: "entry-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    message: {
      id: messageId,
      role: "user",
      text: "hi",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      turnId: messageTurnId,
      streaming,
    },
    ...rest,
  } as PendingThreadFeedEntry;
}

function activityGroupEntry(activityIds: ReadonlyArray<string>): PendingThreadFeedEntry {
  return {
    type: "activity-group",
    id: activityIds[0] ?? "group-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    turnId,
    activities: activityIds.map((id) => ({ id, turnId })),
  } as unknown as PendingThreadFeedEntry;
}

describe("threadSupportsConversationRollback", () => {
  it("reads the provider the session runs on before the model's provider", () => {
    expect(
      threadSupportsConversationRollback({
        providers: [provider(sessionInstance, false), provider(modelInstance, true)],
        sessionProviderInstanceId: sessionInstance,
        modelInstanceId: modelInstance,
      }),
    ).toBe(false);
  });

  it("falls back to the model's provider when the thread has no session", () => {
    expect(
      threadSupportsConversationRollback({
        providers: [provider(modelInstance, true)],
        sessionProviderInstanceId: null,
        modelInstanceId: modelInstance,
      }),
    ).toBe(true);
  });

  it("treats an absent capability flag as supported, like web", () => {
    expect(
      threadSupportsConversationRollback({
        providers: [provider(modelInstance)],
        sessionProviderInstanceId: null,
        modelInstanceId: modelInstance,
      }),
    ).toBe(true);
  });

  it("gates off when no provider matches", () => {
    expect(
      threadSupportsConversationRollback({
        providers: [provider(modelInstance, true)],
        sessionProviderInstanceId: sessionInstance,
        modelInstanceId: null,
      }),
    ).toBe(false);
  });
});

describe("newWorktreeForkMessageIds", () => {
  const user = (id: string, turn: string) => ({
    id: id as MessageId,
    role: "user" as const,
    turnId: turn as TurnId,
  });
  const assistant = (id: string, turn: string) => ({
    ...user(id, turn),
    role: "assistant" as const,
  });
  const checkpoint = (turn: string, checkpointTurnCount: number, status: "ready" | "error") => ({
    turnId: turn as TurnId,
    checkpointTurnCount,
    status,
  });
  // Turn 1 captured its checkpoint, turn 2's capture failed.
  const messages = [
    user("u1", "t1"),
    assistant("a1", "t1"),
    user("u2", "t2"),
    assistant("a2", "t2"),
    user("u3", "t3"),
  ];
  const checkpoints = [checkpoint("t1", 1, "ready"), checkpoint("t2", 2, "error")];

  it("offers the worktree on each user message whose boundary checkpoint is ready", () => {
    expect([...newWorktreeForkMessageIds({ messages, checkpoints, isGitProject: true })]).toEqual([
      "u1",
      "u2",
    ]);
  });

  it("offers it nowhere outside a git project", () => {
    expect(newWorktreeForkMessageIds({ messages, checkpoints, isGitProject: false }).size).toBe(0);
  });
});

describe("persistedMessageId", () => {
  it("names the message on a row the server has recorded", () => {
    expect(persistedMessageId(messageEntry())).toBe(messageId);
  });

  it("names nothing on a queued, unacknowledged or streaming row", () => {
    const queuedTurn = { messageId } as OrchestrationQueuedTurn;
    const pendingMessage = { messageId } as QueuedThreadMessage;
    expect(persistedMessageId(messageEntry({ queuedTurn }))).toBeNull();
    expect(persistedMessageId(messageEntry({ pendingMessage }))).toBeNull();
    expect(persistedMessageId(messageEntry({ pendingMessage, acknowledged: true }))).toBe(
      messageId,
    );
    expect(persistedMessageId(messageEntry({ streaming: true }))).toBeNull();
  });

  it("names nothing on a work-log row, which carries no message", () => {
    const workToggle = { type: "work-toggle", id: "row-1" } as unknown as PendingThreadFeedEntry;
    expect(persistedMessageId(workToggle)).toBeNull();
  });
});

describe("timelineRowRecordRef", () => {
  it("names the message and its turn on a row the server has recorded", () => {
    expect(timelineRowRecordRef(messageEntry({ messageTurnId: turnId }))).toEqual({
      recordId: messageId,
      turnId,
    });
  });

  it("names nothing on a queued, unacknowledged or streaming message row", () => {
    const queuedTurn = { messageId } as OrchestrationQueuedTurn;
    const pendingMessage = { messageId } as QueuedThreadMessage;
    expect(timelineRowRecordRef(messageEntry({ streaming: true }))).toBeNull();
    expect(timelineRowRecordRef(messageEntry({ queuedTurn }))).toBeNull();
    expect(timelineRowRecordRef(messageEntry({ pendingMessage }))).toBeNull();
  });

  it("names the single activity an activity row stands for", () => {
    expect(timelineRowRecordRef(activityGroupEntry(["activity-1"]))).toEqual({
      recordId: "activity-1",
      turnId,
    });
  });

  it("names nothing on a row standing for several activities", () => {
    expect(timelineRowRecordRef(activityGroupEntry(["activity-1", "activity-2"]))).toBeNull();
  });

  it("names the spawning activity on an agent-spawn row, not its client-side group id", () => {
    const entry = {
      type: "agent-spawn",
      id: "group:agents",
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId,
      activity: { id: "activity-spawn", turnId },
    } as unknown as PendingThreadFeedEntry;
    expect(timelineRowRecordRef(entry)).toEqual({ recordId: "activity-spawn", turnId });
  });

  it("names nothing on the client-only fold, toggle and thinking rows", () => {
    for (const type of ["work-toggle", "turn-fold", "thinking"]) {
      const entry = { type, id: `${type}:1`, turnId } as unknown as PendingThreadFeedEntry;
      expect(timelineRowRecordRef(entry)).toBeNull();
    }
  });
});

describe("threadMessageMenuActions", () => {
  const record = { recordId: messageId, turnId } as const;
  const userRow = { role: "user", persistedMessageId: messageId, record } as const;
  const copyIds = ["copy-message-id", "copy-debug-ref"];

  it("opens a location submenu when both fork locations are eligible", () => {
    const actions = threadMessageMenuActions({
      row: userRow,
      forkSupported: true,
      newWorktreeEligible: true,
    });
    expect(actionIds(actions)).toEqual(["fork", ...copyIds]);
    expect(actionIds(actions[0]?.subactions ?? [])).toEqual([
      "fork:same-workspace",
      "fork:new-worktree",
    ]);
  });

  it("stays a flat action when only the same-workspace location is eligible", () => {
    const actions = threadMessageMenuActions({
      row: userRow,
      forkSupported: true,
      newWorktreeEligible: false,
    });
    expect(actionIds(actions)).toEqual(["fork", ...copyIds]);
    expect(actions[0]?.subactions).toBeUndefined();
    expect(threadForkLocationFromActionId(actions[0]!.id!)).toBe("same-workspace");
  });

  it("offers the copy items but no fork items to an assistant row", () => {
    expect(
      actionIds(
        threadMessageMenuActions({
          row: { role: "assistant", persistedMessageId: messageId, record },
          forkSupported: true,
          newWorktreeEligible: true,
        }),
      ),
    ).toEqual(copyIds);
  });

  it("offers the copy items on an activity row, which carries no message at all", () => {
    expect(
      actionIds(
        threadMessageMenuActions({
          row: { role: null, persistedMessageId: null, record: { recordId: "a-1", turnId } },
          forkSupported: true,
          newWorktreeEligible: true,
        }),
      ),
    ).toEqual(copyIds);
  });

  it("offers nothing on a row the server has not recorded yet", () => {
    expect(
      threadMessageMenuActions({
        row: { role: "user", persistedMessageId: null, record: null },
        forkSupported: true,
        newWorktreeEligible: true,
      }),
    ).toEqual([]);
  });

  it("offers the copy items when the provider cannot roll a conversation back", () => {
    expect(
      actionIds(
        threadMessageMenuActions({
          row: userRow,
          forkSupported: false,
          newWorktreeEligible: true,
        }),
      ),
    ).toEqual(copyIds);
  });

  it("labels the copy items exactly as the spec names them", () => {
    const actions = threadMessageMenuActions({
      row: userRow,
      forkSupported: false,
      newWorktreeEligible: false,
    });
    expect(actions.map((action) => action.title)).toEqual(["Copy message ID", "Copy debug ref"]);
  });
});

describe("threadMessageCopyAction", () => {
  const row = { threadId, record: { recordId: messageId, turnId } };

  it("copies the bare row id", () => {
    expect(threadMessageCopyAction("copy-message-id", row)).toEqual({
      text: messageId,
      target: "timeline-row-id",
    });
  });

  it("copies one grep-able debug ref, dropping the turn on a turnless row", () => {
    expect(threadMessageCopyAction("copy-debug-ref", row)?.text).toBe(
      "thread=thread-1;turn=turn-1;message=message-1",
    );
    expect(
      threadMessageCopyAction("copy-debug-ref", {
        threadId,
        record: { recordId: messageId, turnId: null },
      })?.text,
    ).toBe("thread=thread-1;message=message-1");
  });

  it("ignores ids that are not copy actions, so fork passes through", () => {
    expect(threadMessageCopyAction("fork", row)).toBeNull();
  });
});

describe("threadForkLocationFromActionId", () => {
  it("ignores ids that are not fork locations, so other actions pass through", () => {
    expect(threadForkLocationFromActionId("copy-message-id")).toBeNull();
  });
});
