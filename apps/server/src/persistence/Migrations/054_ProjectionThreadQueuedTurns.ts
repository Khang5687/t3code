import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `position` is the sequence of the thread.turn-queued event, so insertion
  // order survives without counting rows or renumbering on a removal.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_queued_turns (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      context_json TEXT,
      model_selection_json TEXT,
      interaction_mode TEXT NOT NULL,
      held INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_queued_turns_thread
    ON projection_thread_queued_turns(thread_id, position)
  `;
});
