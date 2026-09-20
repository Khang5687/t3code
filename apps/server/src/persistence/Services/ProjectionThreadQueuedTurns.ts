/**
 * Projection repository for the turn queue: the messages a thread will send,
 * one per turn, once the running turn ends. Rows are ordered by `position`,
 * the sequence of the `thread.turn-queued` event that created them.
 *
 * @module ProjectionThreadQueuedTurnRepository
 */
import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationMessageContext,
  ProviderInteractionMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadQueuedTurn = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  position: NonNegativeInt,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  context: Schema.optional(OrchestrationMessageContext),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: ProviderInteractionMode,
  held: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type ProjectionThreadQueuedTurn = typeof ProjectionThreadQueuedTurn.Type;

export const ThreadScopedQueuedTurnsInput = Schema.Struct({ threadId: ThreadId });
export type ThreadScopedQueuedTurnsInput = typeof ThreadScopedQueuedTurnsInput.Type;

export const RemoveProjectionThreadQueuedTurnInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type RemoveProjectionThreadQueuedTurnInput =
  typeof RemoveProjectionThreadQueuedTurnInput.Type;

export const HoldProjectionThreadQueuedTurnsInput = Schema.Struct({
  threadId: ThreadId,
  held: Schema.Boolean,
});
export type HoldProjectionThreadQueuedTurnsInput = typeof HoldProjectionThreadQueuedTurnsInput.Type;

export interface ProjectionThreadQueuedTurnRepositoryShape {
  readonly upsert: (
    queuedTurn: ProjectionThreadQueuedTurn,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ThreadScopedQueuedTurnsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadQueuedTurn>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadQueuedTurn>,
    ProjectionRepositoryError
  >;
  readonly remove: (
    input: RemoveProjectionThreadQueuedTurnInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Marks (or clears) the whole thread's queue as waiting for Send now. */
  readonly setHeldByThreadId: (
    input: HoldProjectionThreadQueuedTurnsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: ThreadScopedQueuedTurnsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadQueuedTurnRepository extends Context.Service<
  ProjectionThreadQueuedTurnRepository,
  ProjectionThreadQueuedTurnRepositoryShape
>()("t3/persistence/Services/ProjectionThreadQueuedTurns/ProjectionThreadQueuedTurnRepository") {}
