import { expect, it } from "@effect/vitest";
import {
  CommandId,
  type GitCommandError,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  OrchestrationDispatchCommandError,
  type OrchestrationThreadShell,
  WORKTREE_SETUP_ACTIVITY_KIND,
  type WorktreeSetupSnapshot,
  worktreeSetupHandedOff,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { describe } from "vite-plus/test";

import { forkThread, rejectTurnWithoutWorktree, type ForkThreadDeps } from "./ForkWorkspace.ts";
import {
  ProjectSetupScriptProjectNotFoundError,
  type ProjectSetupScriptRunnerInput,
} from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";

const projectId = ProjectId.make("project-1");
const sourceThreadId = ThreadId.make("thread-source");
const forkThreadId = ThreadId.make("thread-fork");
const at = "2026-08-24T10:00:00.000Z" as OrchestrationThread["createdAt"];

const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: at,
  updatedAt: at,
} as unknown as OrchestrationProjectShell;

/**
 * A source with two of its own turns, preceded by one copied user message that
 * ran no turn — the shape that makes a user-message count disagree with the
 * checkpoint turn count.
 */
const source = {
  id: sourceThreadId,
  projectId,
  title: "Source",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  branch: "feature/source",
  worktreePath: "/repo/.worktrees/source",
  messages: [
    { id: MessageId.make("import:fork:c:0"), role: "user", turnId: null },
    { id: MessageId.make("user-1"), role: "user", turnId: TurnId.make("turn-1") },
    { id: MessageId.make("assistant-1"), role: "assistant", turnId: TurnId.make("turn-1") },
    { id: MessageId.make("user-2"), role: "user", turnId: TurnId.make("turn-2") },
    { id: MessageId.make("assistant-2"), role: "assistant", turnId: TurnId.make("turn-2") },
  ],
  checkpoints: [
    {
      turnId: TurnId.make("turn-1"),
      checkpointTurnCount: 1,
      checkpointRef: "ref-1",
      status: "ready",
    },
    {
      turnId: TurnId.make("turn-2"),
      checkpointTurnCount: 2,
      checkpointRef: "ref-2",
      status: "ready",
    },
  ],
} as unknown as OrchestrationThread;

const gitFailure = Object.assign(new Error("git said no"), {
  _tag: "VcsProcessExitError",
}) as unknown as GitCommandError;

interface Calls {
  /** Every side effect in the order it happened. */
  readonly steps: Array<string>;
  readonly created: Array<{ readonly refName: string; readonly newRefName?: string }>;
  readonly restored: Array<{ readonly cwd: string; readonly checkpointRef: string }>;
  readonly removed: Array<string>;
  readonly workspaces: Array<{ readonly branch: string; readonly worktreePath: string }>;
  readonly setupRuns: Array<ProjectSetupScriptRunnerInput>;
  readonly recorded: Array<string>;
}

const makeDeps = (overrides: {
  readonly isRepository?: boolean;
  readonly restored?: boolean;
  readonly createFails?: boolean;
  readonly restoreFails?: boolean;
  readonly thread?: OrchestrationThread;
  /** Resolves once git claims the directory; the checkout then never ends. */
  readonly checkoutHangs?: Deferred.Deferred<void>;
  readonly setupFails?: boolean;
  readonly setupExitCode?: number;
}) =>
  Effect.gen(function* () {
    const calls: Calls = {
      steps: [],
      created: [],
      restored: [],
      removed: [],
      workspaces: [],
      setupRuns: [],
      recorded: [],
    };
    const tracker = yield* WorktreeSetupTracker.make;
    // The `worktree-setup` activity writes, in order: the receipts a test waits on.
    const cards = yield* Queue.unbounded<WorktreeSetupSnapshot>();
    const deps: ForkThreadDeps = {
      projectionSnapshotQuery: {
        getThreadDetailById: () => Effect.succeed(Option.some(overrides.thread ?? source)),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      },
      gitWorkflow: {
        isRepository: () => Effect.succeed(overrides.isRepository ?? true),
        hasCommit: () => Effect.succeed(true),
        createWorktree: (input, options) =>
          Effect.gen(function* () {
            calls.steps.push("checkout");
            calls.created.push({
              refName: input.refName,
              ...(input.newRefName ? { newRefName: input.newRefName } : {}),
            });
            if (overrides.createFails === true) return yield* Effect.fail(gitFailure);
            yield* (
              options?.progress?.onCheckoutProgress?.({
                percent: 50,
                completed: 1,
                total: 2,
              }) ?? Effect.void
            );
            if (overrides.checkoutHangs) {
              yield* options?.progress?.onWorktreeClaimed?.("/repo/.worktrees/fork") ?? Effect.void;
              yield* Deferred.succeed(overrides.checkoutHangs, undefined);
              return yield* Effect.never;
            }
            return { worktree: { path: "/repo/.worktrees/fork", refName: "t3/deadbeef" } };
          }),
        removeWorktree: (input) =>
          Effect.sync(() => {
            calls.steps.push("remove");
            calls.removed.push(input.path);
          }),
      },
      checkpointStore: {
        restoreCheckpoint: (input) =>
          Effect.suspend(() => {
            calls.steps.push("restore");
            calls.restored.push({ cwd: input.cwd, checkpointRef: input.checkpointRef });
            return overrides.restoreFails === true
              ? Effect.fail(gitFailure as never)
              : Effect.succeed(overrides.restored ?? true);
          }),
      },
      projectSetupScriptRunner: {
        runForThread: (input) =>
          Effect.suspend(() => {
            calls.steps.push("setup");
            calls.setupRuns.push(input);
            return overrides.setupFails === true
              ? Effect.fail(
                  new ProjectSetupScriptProjectNotFoundError({
                    threadId: input.threadId,
                    worktreePath: input.worktreePath,
                  }),
                )
              : Effect.succeed({
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "Setup",
                  scriptCommand: "pnpm i",
                  terminalId: "setup-terminal",
                  cwd: input.worktreePath,
                  async: true,
                  completion: Effect.succeed({
                    exitCode: overrides.setupExitCode ?? 0,
                    durationMs: 1,
                  }),
                });
          }),
      },
      worktreeSetupTracker: tracker,
      newForkBranch: Effect.succeed("t3/deadbeef"),
      enqueue: (command) =>
        Effect.sync(() => {
          calls.steps.push(`enqueue:${command.threadId}`);
          return { sequence: 7 };
        }),
      setThreadWorkspace: (input) =>
        Effect.sync(() => {
          calls.steps.push("workspace");
          calls.workspaces.push({ branch: input.branch, worktreePath: input.worktreePath });
        }),
      recordWorktreeSetup: (snapshot) => Queue.offer(cards, snapshot).pipe(Effect.asVoid),
      recordSetupScriptStarted: () =>
        Effect.sync(() => {
          calls.recorded.push("setup-script.started");
        }),
      recordSetupScriptLaunchFailure: () =>
        Effect.sync(() => {
          calls.recorded.push("setup-script.failed");
        }),
    };
    /** Every card written so far, in order. */
    const written: Array<WorktreeSetupSnapshot> = [];
    /** The card the fork settles on, once its preparation has finished. */
    const settledCard = Effect.gen(function* () {
      while (true) {
        const card = yield* Queue.take(cards);
        written.push(card);
        if (card.phase !== "running") return card;
      }
    });
    return { deps, calls, tracker, settledCard, written };
  });

const forkCommand = (input: { readonly location: "same-workspace" | "new-worktree" }) =>
  ({
    type: "thread.fork",
    commandId: CommandId.make("command-fork"),
    sourceThreadId,
    threadId: forkThreadId,
    messageId: MessageId.make("user-2"),
    location: input.location,
    createdAt: at,
  }) as const;

const stageStatuses = (card: WorktreeSetupSnapshot) =>
  Object.fromEntries(card.stages.map((stage) => [stage.id, stage.status]));

describe("forkThread", () => {
  it.effect("forks in place without touching git or tracking a setup", () =>
    Effect.gen(function* () {
      const { deps, calls, tracker } = yield* makeDeps({});
      const result = yield* forkThread(deps)(forkCommand({ location: "same-workspace" }));

      expect(result).toEqual({ sequence: 7 });
      expect(calls.steps).toEqual([`enqueue:${forkThreadId}`]);
      expect(yield* tracker.get(forkThreadId)).toBeNull();
    }),
  );

  it.effect("creates the fork first, then checks out, restores, points it there, and sets up", () =>
    Effect.gen(function* () {
      const { deps, calls, settledCard, written } = yield* makeDeps({});
      const result = yield* forkThread(deps)(forkCommand({ location: "new-worktree" }));
      expect(result).toEqual({ sequence: 7 });

      const card = yield* settledCard;
      // Recorded when it starts, when the fork becomes usable (so a reload
      // opens its composer while the script runs on), and when it settles.
      expect(written.map((entry) => [entry.phase, worktreeSetupHandedOff(entry)])).toEqual([
        ["running", false],
        ["running", true],
        ["done", true],
      ]);
      expect(calls.steps).toEqual([
        `enqueue:${forkThreadId}`,
        "checkout",
        "restore",
        "workspace",
        "setup",
      ]);
      expect(calls.created).toEqual([{ refName: "feature/source", newRefName: "t3/deadbeef" }]);
      // Turn 1, the last turn before the cut — not 2 (the user messages the
      // fork copies, one of which ran no turn at all).
      expect(calls.restored).toEqual([{ cwd: "/repo/.worktrees/fork", checkpointRef: "ref-1" }]);
      expect(calls.workspaces).toEqual([
        { branch: "t3/deadbeef", worktreePath: "/repo/.worktrees/fork" },
      ]);
      expect(calls.setupRuns).toMatchObject([
        {
          threadId: forkThreadId,
          projectId,
          projectCwd: "/repo",
          worktreePath: "/repo/.worktrees/fork",
        },
      ]);
      expect(calls.recorded).toEqual(["setup-script.started"]);
      expect(card.phase).toBe("done");
      expect(card.worktreePath).toBe("/repo/.worktrees/fork");
      expect(card.setupScript?.name).toBe("Setup");
      expect(stageStatuses(card)).toEqual({
        checkout: "done",
        submodules: "skipped",
        restore: "done",
        "setup-script": "done",
      });
      expect(calls.removed).toEqual([]);
    }),
  );

  it.effect("records a setup script that exits non-zero without failing the fork", () =>
    Effect.gen(function* () {
      const { deps, calls, settledCard } = yield* makeDeps({ setupExitCode: 2 });
      yield* forkThread(deps)(forkCommand({ location: "new-worktree" }));

      const card = yield* settledCard;
      expect(card.phase).toBe("done");
      expect(card.stages.find((stage) => stage.id === "setup-script")).toMatchObject({
        status: "failed",
        detail: "exit 2",
      });
      expect(calls.removed).toEqual([]);
    }),
  );

  it.effect("keeps the fork and its worktree when the setup script fails to start", () =>
    Effect.gen(function* () {
      const { deps, calls, settledCard } = yield* makeDeps({ setupFails: true });
      yield* forkThread(deps)(forkCommand({ location: "new-worktree" }));

      const card = yield* settledCard;
      expect(card.phase).toBe("done");
      expect(stageStatuses(card)["setup-script"]).toBe("failed");
      expect(calls.recorded).toEqual(["setup-script.failed"]);
      expect(calls.workspaces).toHaveLength(1);
      expect(calls.removed).toEqual([]);
    }),
  );

  it.effect(
    "fails the card and removes the checkout when the restore fails, keeping the fork",
    () =>
      Effect.gen(function* () {
        const { deps, calls, settledCard } = yield* makeDeps({ restoreFails: true });
        yield* forkThread(deps)(forkCommand({ location: "new-worktree" }));

        const card = yield* settledCard;
        expect(card.phase).toBe("failed");
        expect(card.error).toContain("git said no");
        expect(stageStatuses(card)).toMatchObject({ checkout: "done", restore: "failed" });
        // The fork thread stays with its failed card; only the checkout goes.
        expect(calls.steps).toEqual([`enqueue:${forkThreadId}`, "checkout", "restore", "remove"]);
        expect(calls.removed).toEqual(["/repo/.worktrees/fork"]);
        expect(calls.workspaces).toEqual([]);
        expect(calls.setupRuns).toEqual([]);
      }),
  );

  it.effect("fails rather than downgrading when the restore finds nothing to restore", () =>
    Effect.gen(function* () {
      const { deps, calls, settledCard } = yield* makeDeps({ restored: false });
      yield* forkThread(deps)(forkCommand({ location: "new-worktree" }));

      const card = yield* settledCard;
      expect(card.phase).toBe("failed");
      expect(card.error).toBe("No filesystem checkpoint is available for turn 1.");
      expect(calls.removed).toEqual(["/repo/.worktrees/fork"]);
      expect(calls.workspaces).toEqual([]);
    }),
  );

  it.effect("reports a failed checkout on the fork's card", () =>
    Effect.gen(function* () {
      const { deps, calls, settledCard } = yield* makeDeps({ createFails: true });
      yield* forkThread(deps)(forkCommand({ location: "new-worktree" }));

      const card = yield* settledCard;
      expect(card.phase).toBe("failed");
      expect(stageStatuses(card).checkout).toBe("failed");
      expect(calls.restored).toEqual([]);
      expect(calls.workspaces).toEqual([]);
    }),
  );

  it.effect("cancel removes the checkout and marks the card cancelled", () =>
    Effect.gen(function* () {
      const claimed = yield* Deferred.make<void>();
      const { deps, calls, tracker, settledCard } = yield* makeDeps({ checkoutHangs: claimed });
      yield* forkThread(deps)(forkCommand({ location: "new-worktree" }));
      yield* Deferred.await(claimed);

      expect(yield* tracker.cancel(forkThreadId)).toBe(true);
      const card = yield* settledCard;
      expect(card.phase).toBe("cancelled");
      expect(calls.removed).toEqual(["/repo/.worktrees/fork"]);
      expect(calls.workspaces).toEqual([]);
    }),
  );

  it.effect("a cancel that lands before the preparation starts still settles the card", () =>
    Effect.gen(function* () {
      const { deps, calls, tracker, settledCard } = yield* makeDeps({});
      const enqueued = yield* Deferred.make<void>();
      const landed = yield* Deferred.make<void>();
      const forking = yield* forkThread({
        ...deps,
        // The cancel arrives while the fork command is still in the queue.
        enqueue: (command) =>
          Deferred.succeed(enqueued, undefined).pipe(
            Effect.andThen(Deferred.await(landed)),
            Effect.andThen(deps.enqueue(command)),
          ),
      })(forkCommand({ location: "new-worktree" })).pipe(Effect.forkChild);
      yield* Deferred.await(enqueued);

      expect(yield* tracker.cancel(forkThreadId)).toBe(true);
      yield* Deferred.succeed(landed, undefined);
      yield* Fiber.join(forking);
      expect((yield* settledCard).phase).toBe("cancelled");
      expect(calls.steps).toEqual([`enqueue:${forkThreadId}`]);
    }),
  );

  it.effect("refuses before creating a thread when the project is not a repository", () =>
    Effect.gen(function* () {
      const { deps, calls } = yield* makeDeps({ isRepository: false });
      const error = yield* forkThread(deps)(forkCommand({ location: "new-worktree" })).pipe(
        Effect.flip,
      );

      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(calls.steps).toEqual([]);
    }),
  );

  it.effect("refuses before creating a thread when the boundary's capture never landed", () =>
    Effect.gen(function* () {
      const { deps, calls } = yield* makeDeps({
        thread: {
          ...source,
          checkpoints: source.checkpoints.map((checkpoint) =>
            checkpoint.checkpointTurnCount === 1
              ? { ...checkpoint, status: "missing" }
              : checkpoint,
          ),
        } as OrchestrationThread,
      });
      const error = yield* forkThread(deps)(forkCommand({ location: "new-worktree" })).pipe(
        Effect.flip,
      );

      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(calls.steps).toEqual([]);
    }),
  );

  it.effect("refuses a boundary that is not a user message of the source", () =>
    Effect.gen(function* () {
      const { deps, calls } = yield* makeDeps({});
      const error = yield* forkThread(deps)({
        ...forkCommand({ location: "new-worktree" }),
        messageId: MessageId.make("assistant-1"),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(calls.steps).toEqual([]);
    }),
  );

  it.effect("settles the setup and prepares nothing when the fork is rejected", () =>
    Effect.gen(function* () {
      const { deps, calls, settledCard } = yield* makeDeps({});
      yield* forkThread({
        ...deps,
        enqueue: () => Effect.fail(new OrchestrationDispatchCommandError({ message: "rejected" })),
      })(forkCommand({ location: "new-worktree" })).pipe(Effect.flip);

      expect((yield* settledCard).phase).toBe("failed");
      expect(calls.steps).toEqual([]);
    }),
  );
});

describe("rejectTurnWithoutWorktree", () => {
  const guard = (input: {
    readonly live?: WorktreeSetupSnapshot["phase"];
    readonly shell?: Partial<OrchestrationThreadShell>;
    readonly recordedSetup?: boolean;
  }) =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      if (input.live) {
        yield* tracker.begin({
          threadId: forkThreadId,
          branch: null,
          baseRef: null,
          stages: ["checkout", "restore", "setup-script"],
          fiber: null,
        });
        if (input.live !== "running") yield* tracker.finish(forkThreadId, input.live);
      }
      return yield* rejectTurnWithoutWorktree({
        worktreeSetupTracker: tracker,
        projectionSnapshotQuery: {
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                forkedFrom: null,
                worktreePath: null,
                ...input.shell,
              } as OrchestrationThreadShell),
            ),
          getThreadDetailById: () =>
            Effect.succeed(
              Option.some({
                activities: input.recordedSetup ? [{ kind: WORKTREE_SETUP_ACTIVITY_KIND }] : [],
              } as unknown as OrchestrationThread),
            ),
        },
      })(forkThreadId).pipe(
        Effect.match({ onFailure: (error) => error.message, onSuccess: () => "allowed" }),
      );
    });
  const forkedFrom = source.id as never;

  it.effect("holds a turn while the worktree is still being prepared", () =>
    Effect.gen(function* () {
      expect(yield* guard({ live: "running" })).toBe(
        "The thread's worktree is still being prepared.",
      );
    }),
  );

  it.effect("refuses a fork whose worktree never arrived, even after a restart", () =>
    Effect.gen(function* () {
      expect(
        yield* guard({
          shell: { forkedFrom: { threadId: forkedFrom } as never },
          recordedSetup: true,
        }),
      ).toBe("This fork has no worktree. Delete it and fork again.");
    }),
  );

  it.effect("lets a same-workspace fork of a project-root thread run", () =>
    Effect.gen(function* () {
      expect(yield* guard({ shell: { forkedFrom: { threadId: forkedFrom } as never } })).toBe(
        "allowed",
      );
    }),
  );

  it.effect("lets a fork with its worktree run", () =>
    Effect.gen(function* () {
      expect(
        yield* guard({
          live: "done",
          shell: { forkedFrom: { threadId: forkedFrom } as never, worktreePath: "/w" as never },
          recordedSetup: true,
        }),
      ).toBe("allowed");
    }),
  );
});
