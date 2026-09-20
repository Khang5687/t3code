import { ChatAttachment, ModelSelection, OrchestrationMessageContext } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  HoldProjectionThreadQueuedTurnsInput,
  ProjectionThreadQueuedTurn,
  ProjectionThreadQueuedTurnRepository,
  type ProjectionThreadQueuedTurnRepositoryShape,
  RemoveProjectionThreadQueuedTurnInput,
  ThreadScopedQueuedTurnsInput,
} from "../Services/ProjectionThreadQueuedTurns.ts";

const ProjectionThreadQueuedTurnDbRowSchema = ProjectionThreadQueuedTurn.mapFields(
  Struct.assign({
    attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
    context: Schema.NullOr(Schema.fromJsonString(OrchestrationMessageContext)),
    modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    held: Schema.Number,
  }),
);

function toProjectionThreadQueuedTurn(
  row: Schema.Schema.Type<typeof ProjectionThreadQueuedTurnDbRowSchema>,
): ProjectionThreadQueuedTurn {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    position: row.position,
    text: row.text,
    attachments: row.attachments,
    interactionMode: row.interactionMode,
    held: row.held === 1,
    createdAt: row.createdAt,
    ...(row.context !== null ? { context: row.context } : {}),
    ...(row.modelSelection !== null ? { modelSelection: row.modelSelection } : {}),
  };
}

const makeProjectionThreadQueuedTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadQueuedTurn,
    execute: (row) => sql`
      INSERT INTO projection_thread_queued_turns (
        message_id,
        thread_id,
        position,
        text,
        attachments_json,
        context_json,
        model_selection_json,
        interaction_mode,
        held,
        created_at
      )
      VALUES (
        ${row.messageId},
        ${row.threadId},
        ${row.position},
        ${row.text},
        ${JSON.stringify(row.attachments)},
        ${row.context !== undefined ? JSON.stringify(row.context) : null},
        ${row.modelSelection !== undefined ? JSON.stringify(row.modelSelection) : null},
        ${row.interactionMode},
        ${row.held ? 1 : 0},
        ${row.createdAt}
      )
      ON CONFLICT (message_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        position = excluded.position,
        text = excluded.text,
        attachments_json = excluded.attachments_json,
        context_json = excluded.context_json,
        model_selection_json = excluded.model_selection_json,
        interaction_mode = excluded.interaction_mode,
        held = excluded.held,
        created_at = excluded.created_at
    `,
  });

  const listRowsByThreadId = SqlSchema.findAll({
    Request: ThreadScopedQueuedTurnsInput,
    Result: ProjectionThreadQueuedTurnDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        position AS "position",
        text AS "text",
        attachments_json AS "attachments",
        context_json AS "context",
        model_selection_json AS "modelSelection",
        interaction_mode AS "interactionMode",
        held AS "held",
        created_at AS "createdAt"
      FROM projection_thread_queued_turns
      WHERE thread_id = ${threadId}
      ORDER BY position ASC
    `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadQueuedTurnDbRowSchema,
    execute: () => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        position AS "position",
        text AS "text",
        attachments_json AS "attachments",
        context_json AS "context",
        model_selection_json AS "modelSelection",
        interaction_mode AS "interactionMode",
        held AS "held",
        created_at AS "createdAt"
      FROM projection_thread_queued_turns
      ORDER BY position ASC
    `,
  });

  const removeRow = SqlSchema.void({
    Request: RemoveProjectionThreadQueuedTurnInput,
    execute: ({ threadId, messageId }) => sql`
      DELETE FROM projection_thread_queued_turns
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
    `,
  });

  const setHeldRows = SqlSchema.void({
    Request: HoldProjectionThreadQueuedTurnsInput,
    execute: ({ threadId, held }) => sql`
      UPDATE projection_thread_queued_turns
      SET held = ${held ? 1 : 0}
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteRowsByThreadId = SqlSchema.void({
    Request: ThreadScopedQueuedTurnsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_queued_turns
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    upsert: (row) =>
      upsertRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.upsert:query")),
      ),
    listByThreadId: (input) =>
      listRowsByThreadId(input).pipe(
        Effect.map((rows) => rows.map(toProjectionThreadQueuedTurn)),
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.listByThreadId:query"),
        ),
      ),
    listAll: () =>
      listAllRows().pipe(
        Effect.map((rows) => rows.map(toProjectionThreadQueuedTurn)),
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.listAll:query"),
        ),
      ),
    remove: (input) =>
      removeRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.remove:query")),
      ),
    setHeldByThreadId: (input) =>
      setHeldRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.setHeldByThreadId:query"),
        ),
      ),
    deleteByThreadId: (input) =>
      deleteRowsByThreadId(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadQueuedTurnRepository.deleteByThreadId:query"),
        ),
      ),
  } satisfies ProjectionThreadQueuedTurnRepositoryShape;
});

export const ProjectionThreadQueuedTurnRepositoryLive = Layer.effect(
  ProjectionThreadQueuedTurnRepository,
  makeProjectionThreadQueuedTurnRepository,
);
