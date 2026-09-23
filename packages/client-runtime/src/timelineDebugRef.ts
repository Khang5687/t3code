/**
 * One grep-able line identifying a timeline record in the event log:
 * `thread=<id>;turn=<id>;message=<id>`. Rows with no turn (thread-level
 * activity) drop the `turn=` segment rather than emitting it empty, so a
 * log search never matches on a placeholder value. Shared by the web
 * hover affordance and the mobile long-press menu.
 */
export function formatTimelineDebugRef(ref: {
  threadId: string;
  turnId?: string | null | undefined;
  messageId: string;
}): string {
  return [
    `thread=${ref.threadId}`,
    ...(ref.turnId ? [`turn=${ref.turnId}`] : []),
    `message=${ref.messageId}`,
  ].join(";");
}
