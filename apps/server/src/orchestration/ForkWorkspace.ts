import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  canForkIntoNewWorktree,
  hasThreadCheckpointForTurn,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  resolveForkBoundary,
  resolveForkCheckpointTurn,
  type ThreadId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  worktreeSetupHandedOff,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";

import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import type * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import type * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

export type ThreadForkCommand = Extract<OrchestrationCommand, { type: "thread.fork" }>;

const isDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

/** The recorders a worktree bootstrap uses, so a fork writes the same `setup-script.*` activities. */
export interface SetupScriptRecorders {
  readonly recordSetupScriptStarted: (input: {
    readonly threadId: ThreadId;
    readonly requestedAt: string;
    readonly worktreePath: string;
    readonly scriptId: string;
    readonly scriptName: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  readonly recordSetupScriptLaunchFailure: (input: {
    readonly threadId: ThreadId;
    readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
    readonly requestedAt: string;
    readonly worktreePath: string;
  }) => Effect.Effect<void>;
}

/** Narrowed to what this workflow calls, so a caller (and a test) supplies no more. */
export interface ForkThreadDeps extends SetupScriptRecorders {
  readonly projectionSnapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadDetailById" | "getProjectShellById"
  >;
  readonly gitWorkflow: Pick<
    GitWorkflowService.GitWorkflowService["Service"],
    "isRepository" | "hasCommit" | "createWorktree" | "removeWorktree"
  >;
  readonly checkpointStore: Pick<CheckpointStore.CheckpointStore["Service"], "restoreCheckpoint">;
  readonly projectSetupScriptRunner: Pick<
    ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"],
    "runForThread"
  >;
  readonly worktreeSetupTracker: WorktreeSetupTracker.WorktreeSetupTracker["Service"];
  /** Names the branch the fork's worktree is checked out on. */
  readonly newForkBranch: Effect.Effect<string, OrchestrationDispatchCommandError>;
  /** Queues the fork command. Resolves once the fork thread exists. */
  readonly enqueue: (
    command: ThreadForkCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  /** Points the fork thread at its checkout (`thread.meta.update`). */
  readonly setThreadWorkspace: (input: {
    readonly threadId: ThreadId;
    readonly branch: string;
    readonly worktreePath: string;
  }) => Effect.Effect<void, OrchestrationDispatchCommandError>;
  /** Upserts the thread's `worktree-setup` activity, the card a reload reads. */
  readonly recordWorktreeSetup: (snapshot: WorktreeSetupSnapshot) => Effect.Effect<void>;
}

/**
 * Forks a thread. A same-workspace fork is just the command. A new-worktree
 * fork is checked for eligibility, queued, and returns as soon as the fork
 * thread exists; its checkout, checkpoint restore, and setup script then run
 * detached, reported through the worktree setup tracker and the thread's
 * `worktree-setup` activity the way a worktree bootstrap is.
 *
 * The fork is created with no workspace and pointed at its checkout only once
 * the boundary checkpoint is restored into it, so nothing ever runs against a
 * half-restored tree or the project root in its place. A failed or cancelled
 * preparation removes the checkout and leaves the fork with its failed card;
 * the user deletes it like any worktree thread. The source is never touched.
 *
 * Checkpoint refs live in the repository's common ref store rather than the
 * per-worktree one, so the ref the source captured resolves from this sibling
 * worktree without reaching into the source's git dir.
 */
export const forkThread = (deps: ForkThreadDeps) =>
  Effect.fn("forkThread")(function* (command: ThreadForkCommand) {
    // Only the preparation below may give a fork a worktree.
    if (command.location !== "new-worktree") return yield* deps.enqueue(command);

    const plan = yield* planForkWorktree(deps, command);
    // Detached so a dropped client cannot abandon a half-made checkout. It is
    // registered with the tracker before the fork thread exists, so there is
    // no moment where the thread is there and a send is not held, and it
    // starts only once the thread does.
    const created = yield* Deferred.make<void, OrchestrationDispatchCommandError>();
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        // Started at once so it is already parked on `created`, inside its
        // own cancel handling, by the time a cancel can reach it. A fiber
        // interrupted before it ever ran would skip that handling.
        const fiber = yield* Effect.forkDetach(
          prepareForkWorktree(deps, command.threadId, plan, Deferred.await(created)),
          { startImmediately: true },
        );
        yield* deps.worktreeSetupTracker.begin({
          threadId: command.threadId,
          branch: plan.branch,
          baseRef: plan.baseRef,
          stages: ["checkout", "submodules", "restore", "setup-script"],
          fiber,
        });
      }),
    );
    // A rejected (or abandoned) fork has no thread to prepare; the preparation
    // settles its tracker entry as failed without touching git.
    return yield* deps
      .enqueue(command)
      .pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Deferred.succeed(created, undefined)
            : Deferred.fail(
                created,
                new OrchestrationDispatchCommandError({ message: "The fork was not created." }),
              ),
        ),
      );
  });

/**
 * Everything a new-worktree fork can be refused for, settled before the fork
 * thread exists so a request that could never work leaves nothing behind.
 */
const planForkWorktree = Effect.fn("planForkWorktree")(function* (
  deps: ForkThreadDeps,
  command: ThreadForkCommand,
) {
  const { gitWorkflow, projectionSnapshotQuery } = deps;
  const refuse = (message: string) => new OrchestrationDispatchCommandError({ message });
  const failedTo = (detail: string) => (cause: unknown) =>
    isDispatchCommandError(cause)
      ? cause
      : new OrchestrationDispatchCommandError({ message: detail, cause });

  const source = yield* projectionSnapshotQuery
    // The activities are a large read this never looks at.
    .getThreadDetailById(command.sourceThreadId, { activityKinds: [] })
    .pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(failedTo("Failed to read the thread being forked.")),
    );
  if (!source) return yield* refuse(`Thread '${command.sourceThreadId}' was not found.`);

  const boundary = resolveForkBoundary(source.messages, command.messageId);
  if (!boundary) {
    return yield* refuse(
      `Message '${command.messageId}' is not a user message on thread '${command.sourceThreadId}'.`,
    );
  }

  const project = yield* projectionSnapshotQuery
    .getProjectShellById(source.projectId)
    .pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(failedTo("Failed to read the forked thread's project.")),
    );
  if (!project) return yield* refuse(`Project '${source.projectId}' was not found.`);
  const projectCwd = project.workspaceRoot;

  // Not `boundary.turnCount`: that counts the user messages the fork copies,
  // which is what resuming a provider session needs and not what checkpoint
  // refs are numbered by.
  const checkpointTurn = resolveForkCheckpointTurn(
    source.messages,
    source.checkpoints,
    boundary.index,
  );
  const checkpointRef =
    checkpointTurn === 0
      ? checkpointRefForThreadTurn(source.id, 0)
      : source.checkpoints.find((checkpoint) => checkpoint.checkpointTurnCount === checkpointTurn)
          ?.checkpointRef;
  const isGitProject = yield* gitWorkflow
    .isRepository(projectCwd)
    .pipe(Effect.mapError(failedTo("Failed to inspect the project's repository.")));
  // The same gate the clients use to decide whether to offer this at all.
  // `checkpointRef` is present whenever it passes; the check narrows it.
  if (
    !canForkIntoNewWorktree(
      isGitProject,
      hasThreadCheckpointForTurn(source.checkpoints, checkpointTurn),
    ) ||
    checkpointRef === undefined
  ) {
    return yield* refuse(
      "Forking into a new worktree needs a Git repository and a checkpoint at that message.",
    );
  }

  const hasCommit = (refName: string) =>
    gitWorkflow
      .hasCommit({ cwd: projectCwd, refName })
      .pipe(Effect.mapError(failedTo("Failed to resolve the fork's base revision.")));
  // Branch off where the source is, so the fork's diff reads against the same
  // line of work. A source with no branch of its own uses the project
  // checkout's HEAD.
  const baseRef =
    source.branch !== null && (yield* hasCommit(source.branch))
      ? source.branch
      : (yield* hasCommit("HEAD"))
        ? "HEAD"
        : null;
  if (baseRef === null) {
    return yield* refuse(
      "Forking into a new worktree needs a Git repository with at least one commit.",
    );
  }

  return {
    projectId: project.id,
    projectCwd,
    baseRef,
    branch: yield* deps.newForkBranch,
    checkpointRef,
    checkpointTurn,
  };
});

type ForkWorktreePlan = Effect.Success<ReturnType<typeof planForkWorktree>>;

/**
 * Checks out, restores, and points the fork at its worktree, then starts the
 * setup script. Runs on a detached fiber registered with the tracker; a cancel
 * interrupts it until the fork is handed off.
 */
const prepareForkWorktree = (
  deps: ForkThreadDeps,
  threadId: ThreadId,
  plan: ForkWorktreePlan,
  threadCreated: Effect.Effect<void, OrchestrationDispatchCommandError>,
) => {
  const { checkpointStore, gitWorkflow, worktreeSetupTracker: tracker } = deps;
  const settle = (phase: "done" | "failed" | "cancelled", error?: string) =>
    tracker
      .finish(threadId, phase, error)
      .pipe(
        Effect.flatMap((snapshot) => (snapshot ? deps.recordWorktreeSetup(snapshot) : Effect.void)),
      );

  // Git has registered the directory by the time it reports the claim, so an
  // interrupt partway through the checkout still has something to remove.
  // Leaves the branch behind, the same as deleting any worktree thread.
  let claimedWorktreePath: string | null = null;
  // Set once the thread may name the worktree. A cancel that raced the
  // handoff lands after it and must not take the worktree back down.
  let handedOff = false;
  const discardWorktree = Effect.suspend(() =>
    claimedWorktreePath === null
      ? Effect.void
      : gitWorkflow
          .removeWorktree({ cwd: plan.projectCwd, path: claimedWorktreePath, force: true })
          .pipe(Effect.ignoreCause({ log: true })),
  );

  const program = Effect.gen(function* () {
    yield* threadCreated;
    const running = yield* tracker.get(threadId);
    if (running) yield* deps.recordWorktreeSetup(running);

    yield* tracker.stageStatus(threadId, "checkout", "running");
    const checkout = WorktreeSetupTracker.trackWorktreeCheckout(tracker, threadId, (path) =>
      Effect.sync(() => {
        claimedWorktreePath = path;
      }),
    );
    const { worktree } = yield* gitWorkflow.createWorktree(
      { cwd: plan.projectCwd, refName: plan.baseRef, newRefName: plan.branch, path: null },
      { progress: checkout.progress },
    );
    claimedWorktreePath = worktree.path;
    yield* checkout.settle(worktree.path);

    yield* tracker.stageStatus(threadId, "restore", "running");
    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: worktree.path,
      checkpointRef: plan.checkpointRef,
      // Turn 0 is the pre-turn baseline. A thread that never captured one
      // started from the base revision this checkout is already on.
      fallbackToHead: plan.checkpointTurn === 0,
    });
    if (!restored) {
      return yield* new OrchestrationDispatchCommandError({
        message: `No filesystem checkpoint is available for turn ${plan.checkpointTurn}.`,
      });
    }
    yield* tracker.stageStatus(threadId, "restore", "done");

    // From pointing the thread at its checkout on, nothing may interrupt: a
    // cancel would remove a worktree the thread already names.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* tracker.markUncancellable(threadId);
        handedOff = true;
        yield* deps.setThreadWorkspace({
          threadId,
          branch: worktree.refName,
          worktreePath: worktree.path,
        });
        const { awaitExit } = yield* startSetupScript(deps, threadId, plan, worktree.path);
        // The fork is usable from here; record that so a reload or another
        // client opens its composer. The card stays running beside it until
        // the script exits, so a failed install still shows its exit code.
        const usable = yield* tracker.get(threadId);
        if (usable) yield* deps.recordWorktreeSetup(usable);
        yield* awaitExit.pipe(
          Effect.andThen(settle("done")),
          Effect.ignoreCause({ log: true }),
          Effect.forkDetach,
        );
      }),
    );
  });

  return program.pipe(
    Effect.interruptible,
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return handedOff ? Effect.void : settle("cancelled").pipe(Effect.andThen(discardWorktree));
      }
      return settle("failed", forkFailureMessage(cause)).pipe(Effect.andThen(discardWorktree));
    }),
    // Recording the outcome and removing the checkout must finish after a cancel.
    Effect.uninterruptible,
  );
};

const forkFailureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isDispatchCommandError(error)
    ? error.message
    : `Failed to prepare the fork's worktree: ${error instanceof Error ? error.message : String(error)}`;
};

/**
 * Starts the project's setup script in the fork's worktree, the way a worktree
 * bootstrap does, and returns the wait for its exit. Best effort: a script
 * that fails to start or exits non-zero is recorded on the card and never
 * fails the fork or removes its worktree.
 */
const startSetupScript = (
  deps: ForkThreadDeps,
  threadId: ThreadId,
  plan: ForkWorktreePlan,
  worktreePath: string,
): Effect.Effect<{ readonly awaitExit: Effect.Effect<void> }> =>
  Effect.gen(function* () {
    const nothingToAwait = { awaitExit: Effect.void };
    const tracker = deps.worktreeSetupTracker;
    const requestedAt = DateTime.formatIso(yield* DateTime.now);
    yield* tracker.stageStatus(threadId, "setup-script", "running");
    const started = yield* deps.projectSetupScriptRunner
      .runForThread({
        threadId,
        projectId: plan.projectId,
        projectCwd: plan.projectCwd,
        worktreePath,
        observeCompletion: {
          onOutputLine: (line) => tracker.appendTail(threadId, "setup-script", line),
        },
      })
      .pipe(
        Effect.tapError((error) =>
          deps
            .recordSetupScriptLaunchFailure({ threadId, error, requestedAt, worktreePath })
            .pipe(
              Effect.andThen(
                tracker.stageStatus(threadId, "setup-script", "failed", "failed to start"),
              ),
            ),
        ),
        Effect.option,
      );
    if (Option.isNone(started)) return nothingToAwait;
    const script = started.value;
    if (script.status !== "started") {
      yield* tracker.stageStatus(threadId, "setup-script", "skipped", "no setup script");
      return nothingToAwait;
    }
    yield* deps.recordSetupScriptStarted({
      threadId,
      requestedAt,
      worktreePath,
      scriptId: script.scriptId,
      scriptName: script.scriptName,
      terminalId: script.terminalId,
    });
    yield* tracker.update(threadId, (snapshot) => ({
      ...snapshot,
      setupScript: {
        name: script.scriptName,
        command: script.scriptCommand,
        terminalId: script.terminalId,
      },
    }));
    // ponytail: the script's `async: false` is not honoured; the fork is
    // usable once it starts, as it was before this card existed. Holding sends
    // for it needs the flag on the snapshot.
    const completion = script.completion;
    if (!completion) return nothingToAwait;
    const awaitExit = completion.pipe(
      Effect.flatMap(({ exitCode }) =>
        exitCode === 0
          ? tracker.stageStatus(threadId, "setup-script", "done")
          : tracker.stageStatus(
              threadId,
              "setup-script",
              "failed",
              exitCode === null ? "terminal closed before the script finished" : `exit ${exitCode}`,
            ),
      ),
    );
    return { awaitExit };
  });

/**
 * Refuses a turn on a thread that has nowhere safe to run: its worktree is
 * still being prepared, or it is a fork whose worktree never arrived (failed,
 * cancelled, or cut off by a restart). Such a fork has no workspace, and the
 * project root it would fall back to is the wrong tree. Clients gate their
 * composer on the same state; this holds for any client.
 */
export const rejectTurnWithoutWorktree = (deps: {
  readonly worktreeSetupTracker: Pick<WorktreeSetupTracker.WorktreeSetupTracker["Service"], "get">;
  readonly projectionSnapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getThreadDetailById"
  >;
}) =>
  Effect.fn("rejectTurnWithoutWorktree")(
    function* (threadId: ThreadId) {
      const live = yield* deps.worktreeSetupTracker.get(threadId);
      if (live?.phase === "running" && !worktreeSetupHandedOff(live)) {
        return yield* new OrchestrationDispatchCommandError({
          message: "The thread's worktree is still being prepared.",
        });
      }
      const query = deps.projectionSnapshotQuery;
      const shell = yield* query
        .getThreadShellById(threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      // A same-workspace fork can have no worktree too; only a fork that
      // recorded a worktree setup was meant to get one.
      if (!shell?.forkedFrom || shell.worktreePath !== null) return;
      const detail = yield* query
        .getThreadDetailById(threadId, { activityKinds: [WORKTREE_SETUP_ACTIVITY_KIND] })
        .pipe(Effect.map(Option.getOrUndefined));
      if (detail?.activities.some((activity) => activity.kind === WORKTREE_SETUP_ACTIVITY_KIND)) {
        return yield* new OrchestrationDispatchCommandError({
          message: "This fork has no worktree. Delete it and fork again.",
        });
      }
    },
    Effect.mapError((cause) =>
      isDispatchCommandError(cause)
        ? cause
        : new OrchestrationDispatchCommandError({ message: "Failed to read the thread.", cause }),
    ),
  );
