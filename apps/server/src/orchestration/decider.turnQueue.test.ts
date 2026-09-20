import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationQueuedTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" } as const;

function queuedTurn(id: string, overrides: Partial<OrchestrationQueuedTurn> = {}) {
  return {
    messageId: MessageId.make(id),
    text: `queued ${id}`,
    attachments: [],
    interactionMode: "default",
    held: false,
    createdAt: NOW,
    ...overrides,
  } satisfies OrchestrationQueuedTurn;
}

function makeReadModel(input: {
  readonly queuedTurns?: ReadonlyArray<OrchestrationQueuedTurn>;
  readonly session?: OrchestrationSession | null;
  readonly latestTurnState?: "running" | "completed" | "interrupted" | "error";
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: MODEL,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn:
          input.latestTurnState === undefined
            ? null
            : {
                turnId: TURN_ID,
                state: input.latestTurnState,
                requestedAt: NOW,
                startedAt: NOW,
                completedAt: null,
                assistantMessageId: null,
              },
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: input.activities ?? [],
        checkpoints: [],
        queuedTurns: input.queuedTurns ?? [],
        session: input.session ?? null,
      },
    ],
    updatedAt: NOW,
  } satisfies OrchestrationReadModel;
}

function runningSession(): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status: "running",
    providerName: "codex",
    runtimeMode: "approval-required",
    activeTurnId: TURN_ID,
    lastError: null,
    updatedAt: NOW,
  };
}

function sessionSetCommand(status: OrchestrationSession["status"]) {
  return {
    type: "thread.session.set",
    commandId: CommandId.make(`cmd-session-${status}`),
    threadId: THREAD_ID,
    session: {
      threadId: THREAD_ID,
      status,
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
    createdAt: NOW,
  } as const;
}

function queueCommand(id: string) {
  return {
    type: "thread.turn.queue",
    commandId: CommandId.make(`cmd-queue-${id}`),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make(id),
      role: "user",
      text: `queued ${id}`,
      attachments: [],
    },
    modelSelection: MODEL,
    interactionMode: "plan",
    createdAt: NOW,
  } as const;
}

function approvalRequested(): OrchestrationThreadActivity {
  return {
    id: "activity-1" as OrchestrationThreadActivity["id"],
    tone: "approval",
    kind: "approval.requested",
    summary: "Approve command",
    payload: { requestId: "request-1" },
    turnId: TURN_ID,
    createdAt: NOW,
  };
}

it.layer(NodeServices.layer)("turn queue decider", (it) => {
  it.effect("queues behind a running turn instead of starting one", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: queueCommand("message-1"),
        readModel: makeReadModel({ session: runningSession(), latestTurnState: "running" }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.turn-queued"]);
      expect(events[0]?.payload).toMatchObject({
        threadId: THREAD_ID,
        queuedTurn: { messageId: "message-1", interactionMode: "plan", held: false },
      });
    }),
  );

  it.effect("sends straight away when nothing is running", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: queueCommand("message-1"),
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("drains the head when the turn completes", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: sessionSetCommand("ready"),
        readModel: makeReadModel({
          queuedTurns: [queuedTurn("message-1"), queuedTurn("message-2")],
          session: runningSession(),
          latestTurnState: "running",
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.session-set",
        "thread.turn-queue-removed",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const turnStart = events.at(-1);
      expect(turnStart?.payload).toMatchObject({
        threadId: THREAD_ID,
        messageId: "message-1",
        // The thread's live permission policy, not a snapshot from queue time.
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
      expect(events[1]?.payload).toMatchObject({ messageId: "message-1" });
    }),
  );

  it.effect("holds the queue when the turn is stopped", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: sessionSetCommand("interrupted"),
        readModel: makeReadModel({
          queuedTurns: [queuedTurn("message-1")],
          session: runningSession(),
          latestTurnState: "running",
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("does not drain a held row", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: sessionSetCommand("ready"),
        readModel: makeReadModel({
          queuedTurns: [queuedTurn("message-1", { held: true })],
          session: runningSession(),
          latestTurnState: "running",
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("does not drain while an approval is open", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: sessionSetCommand("ready"),
        readModel: makeReadModel({
          queuedTurns: [queuedTurn("message-1")],
          session: runningSession(),
          latestTurnState: "running",
          activities: [approvalRequested()],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("sends a queued row on demand, running turn or not", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.queue.send",
          commandId: CommandId.make("cmd-send-now"),
          threadId: THREAD_ID,
          messageId: MessageId.make("message-2"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          queuedTurns: [queuedTurn("message-1"), queuedTurn("message-2")],
          session: runningSession(),
          latestTurnState: "running",
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.turn-queue-removed",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      expect(events[0]?.payload).toMatchObject({ messageId: "message-2" });
    }),
  );

  it.effect("rejects removing a row that is not queued", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.queue.remove",
            commandId: CommandId.make("cmd-remove-missing"),
            threadId: THREAD_ID,
            messageId: MessageId.make("message-9"),
            createdAt: NOW,
          },
          readModel: makeReadModel({ queuedTurns: [queuedTurn("message-1")] }),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("removes a queued row", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.queue.remove",
          commandId: CommandId.make("cmd-remove"),
          threadId: THREAD_ID,
          messageId: MessageId.make("message-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({ queuedTurns: [queuedTurn("message-1")] }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.turn-queue-removed"]);
    }),
  );
});
