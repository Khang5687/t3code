import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProjectId,
  ProviderInstanceId,
  type ThreadForkLocation,
  ThreadId,
  TurnId,
  isImportedAgentSessionMessageId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const projectId = ProjectId.make("project-1");
const sourceThreadId = ThreadId.make("thread-source");
const forkThreadId = ThreadId.make("thread-fork");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const forkCommandId = CommandId.make("command-fork");

const attachment: ChatAttachment = {
  type: "image",
  id: "attachment-1",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 1024,
};

/** Minute `index` past 10:00, so message order and timestamps agree. */
const at = (index: number) =>
  `2026-08-24T10:${String(index).padStart(2, "0")}:00.000Z` as OrchestrationEvent["occurredAt"];

let nextSequence = 0;

type SeedEvent = Omit<
  OrchestrationEvent,
  "sequence" | "eventId" | "commandId" | "causationEventId" | "correlationId" | "metadata"
>;

/** Projects one seed event, filling in the bookkeeping fields these tests
 *  never assert on. */
const apply = (readModel: OrchestrationReadModel, event: SeedEvent) => {
  nextSequence += 1;
  const commandId = CommandId.make(`command-${nextSequence}`);
  return projectEvent(readModel, {
    sequence: nextSequence,
    eventId: EventId.make(`event-${nextSequence}`),
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {},
    ...event,
  } as OrchestrationEvent);
};

/**
 * A source thread with `turns` user/assistant pairs. The user message of turn
 * `attachmentTurn` (1-based) carries an attachment, so tests can prove copies
 * keep them and that the boundary message itself is left behind.
 */
const seedSource = (options: {
  readonly turns: number;
  readonly attachmentTurn?: number;
  readonly openTurn?: boolean;
}) =>
  Effect.gen(function* () {
    nextSequence = 0;
    let readModel = yield* apply(createEmptyReadModel(at(0)), {
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: at(0),
      payload: {
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: at(0),
        updatedAt: at(0),
      },
    });
    readModel = yield* apply(readModel, {
      aggregateKind: "thread",
      aggregateId: sourceThreadId,
      type: "thread.created",
      occurredAt: at(0),
      payload: {
        threadId: sourceThreadId,
        projectId,
        title: "Source thread",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: "feature/source",
        worktreePath: "/tmp/worktrees/source",
        createdAt: at(0),
        updatedAt: at(0),
      },
    });
    for (let turn = 1; turn <= options.turns; turn += 1) {
      const userAt = at(turn * 2 - 1);
      readModel = yield* apply(readModel, {
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        type: "thread.message-sent",
        occurredAt: userAt,
        payload: {
          threadId: sourceThreadId,
          messageId: MessageId.make(`source-user-${turn}`),
          role: "user",
          text: `ask ${turn}`,
          ...(options.attachmentTurn === turn ? { attachments: [attachment] } : {}),
          context: { version: 1, records: [] },
          turnId: null,
          streaming: false,
          createdAt: userAt,
          updatedAt: userAt,
        },
      });
      const assistantAt = at(turn * 2);
      readModel = yield* apply(readModel, {
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        type: "thread.message-sent",
        occurredAt: assistantAt,
        payload: {
          threadId: sourceThreadId,
          messageId: MessageId.make(`source-assistant-${turn}`),
          role: "assistant",
          text: `answer ${turn}`,
          turnId: TurnId.make(`source-turn-${turn}`),
          streaming: false,
          createdAt: assistantAt,
          updatedAt: assistantAt,
        },
      });
    }
    if (options.openTurn === true) {
      const turnAt = at(options.turns * 2 + 1);
      readModel = yield* apply(readModel, {
        aggregateKind: "thread",
        aggregateId: sourceThreadId,
        type: "thread.turn-start-requested",
        occurredAt: turnAt,
        payload: {
          threadId: sourceThreadId,
          messageId: MessageId.make(`source-user-${options.turns}`),
          runtimeMode: "approval-required",
          interactionMode: "plan",
          createdAt: turnAt,
        },
      });
    }
    return readModel;
  });

const fork = (input: {
  readonly readModel: OrchestrationReadModel;
  readonly messageId: MessageId;
  readonly threadId?: ThreadId;
  readonly sourceThreadId?: ThreadId;
  readonly location?: ThreadForkLocation;
}) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.fork",
      commandId: forkCommandId,
      sourceThreadId: input.sourceThreadId ?? sourceThreadId,
      threadId: input.threadId ?? forkThreadId,
      messageId: input.messageId,
      location: input.location ?? "same-workspace",
      createdAt: at(59),
    },
    readModel: input.readModel,
  }).pipe(Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])));

/**
 * Projects the fork's events and returns the resulting fork. Asserts on every
 * call that the source thread came through byte-identical, so no case can
 * forget the invariant that a fork never touches what it branched from.
 */
const project = (readModel: OrchestrationReadModel, events: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const sourceBefore = readModel.threads.find((thread) => thread.id === sourceThreadId);
    let projected = readModel;
    for (const [index, event] of events.entries()) {
      projected = yield* projectEvent(projected, {
        ...(event as object),
        sequence: nextSequence + index + 1,
      } as OrchestrationEvent);
    }
    expect(projected.threads.find((thread) => thread.id === sourceThreadId)).toEqual(sourceBefore);
    return projected.threads.find((thread) => thread.id === forkThreadId);
  });

it.layer(NodeServices.layer)("thread fork", (it) => {
  it.effect("copies every message before the boundary and inherits the source setup", () =>
    Effect.gen(function* () {
      const readModel = yield* seedSource({ turns: 3 });
      const events = yield* fork({ readModel, messageId: MessageId.make("source-user-3") });

      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
        "thread.settled",
      ]);
      // Every fork event is history, not live traffic: the checkpoint reactor
      // and the awareness relay both skip on this marker.
      expect(events.every((event) => event.metadata.historyImport === true)).toBe(true);

      const forked = yield* project(readModel, events);
      expect(forked).toMatchObject({
        title: "Source thread (fork)",
        projectId,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: "feature/source",
        worktreePath: "/tmp/worktrees/source",
        forkedFrom: { threadId: sourceThreadId, turnCount: 2, title: "Source thread" },
        settledOverride: "settled",
      });
      expect(forked?.messages.map((message) => message.text)).toEqual([
        "ask 1",
        "answer 1",
        "ask 2",
        "answer 2",
      ]);
      // Fresh ids in the copied-history namespace: the fork is its own
      // aggregate, and these messages must not read as turns it ran itself.
      expect(forked?.messages.every((message) => isImportedAgentSessionMessageId(message.id))).toBe(
        true,
      );
    }),
  );

  it.effect("yields an empty settled fork when the boundary is the first user message", () =>
    Effect.gen(function* () {
      const readModel = yield* seedSource({ turns: 3 });
      const events = yield* fork({ readModel, messageId: MessageId.make("source-user-1") });

      expect(events.map((event) => event.type)).toEqual(["thread.created", "thread.settled"]);

      const forked = yield* project(readModel, events);
      expect(forked?.messages).toEqual([]);
      expect(forked).toMatchObject({
        forkedFrom: { threadId: sourceThreadId, turnCount: 0 },
        settledOverride: "settled",
      });
    }),
  );

  it.effect("keeps attachments and context on copied messages", () =>
    Effect.gen(function* () {
      const readModel = yield* seedSource({ turns: 3, attachmentTurn: 2 });
      const events = yield* fork({ readModel, messageId: MessageId.make("source-user-3") });

      const forked = yield* project(readModel, events);
      expect(forked?.messages.map((message) => message.attachments)).toEqual([
        undefined,
        undefined,
        [attachment],
        undefined,
      ]);
      expect(forked?.messages[0]?.context).toEqual({ version: 1, records: [] });
    }),
  );

  it.effect("leaves the boundary message's attachments behind", () =>
    Effect.gen(function* () {
      const readModel = yield* seedSource({ turns: 2, attachmentTurn: 2 });
      const events = yield* fork({ readModel, messageId: MessageId.make("source-user-2") });

      const forked = yield* project(readModel, events);
      expect(forked?.messages.map((message) => message.text)).toEqual(["ask 1", "answer 1"]);
      expect(forked?.messages.some((message) => (message.attachments ?? []).length > 0)).toBe(
        false,
      );
    }),
  );

  it.effect("forks a mid-run source without touching it", () =>
    Effect.gen(function* () {
      const readModel = yield* seedSource({ turns: 2, openTurn: true });
      const events = yield* fork({ readModel, messageId: MessageId.make("source-user-2") });

      // The open turn is never read and never written: every event the fork
      // produces belongs to the new thread. `project` asserts the rest.
      expect(events.every((event) => event.aggregateId === forkThreadId)).toBe(true);
      const forked = yield* project(readModel, events);
      expect(forked?.messages.map((message) => message.text)).toEqual(["ask 1", "answer 1"]);
    }),
  );

  it.effect("rejects a missing source, a taken thread id, and a non-user boundary", () =>
    Effect.gen(function* () {
      const readModel = yield* seedSource({ turns: 2 });

      const missingSource = yield* fork({
        readModel,
        sourceThreadId: ThreadId.make("thread-gone"),
        messageId: MessageId.make("source-user-2"),
      }).pipe(Effect.flip);
      expect(missingSource._tag).toBe("OrchestrationCommandInvariantError");

      const takenId = yield* fork({
        readModel,
        threadId: sourceThreadId,
        messageId: MessageId.make("source-user-2"),
      }).pipe(Effect.flip);
      expect(takenId._tag).toBe("OrchestrationCommandInvariantError");

      const assistantBoundary = yield* fork({
        readModel,
        messageId: MessageId.make("source-assistant-1"),
      }).pipe(Effect.flip);
      expect(assistantBoundary._tag).toBe("OrchestrationCommandInvariantError");

      const unknownBoundary = yield* fork({
        readModel,
        messageId: MessageId.make("source-user-99"),
      }).pipe(Effect.flip);
      expect(unknownBoundary._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("creates a new-worktree fork with no workspace until its checkout is ready", () =>
    Effect.gen(function* () {
      const readModel = yield* seedSource({ turns: 2 });
      const events = yield* fork({
        readModel,
        messageId: MessageId.make("source-user-2"),
        location: "new-worktree",
      });

      const forked = yield* project(readModel, events);
      // Never the source's workspace: the transport points the fork at its
      // own checkout once the checkpoint is restored into it.
      expect(forked?.branch).toBeNull();
      expect(forked?.worktreePath).toBeNull();
      expect(forked?.forkedFrom).toEqual({
        threadId: sourceThreadId,
        turnCount: 1,
        title: "Source thread",
        sessionResolution: "resumeFromSource",
      });
    }),
  );
});
