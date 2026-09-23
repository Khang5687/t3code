# Plan: steer and queue while a turn runs

Status: steer decided, queue decided. Not yet assigned to an agent. No code
written yet.

## Background

Upstream PR #11673 (`cc839c42b1`) added a client-side "queue". It holds a
message until the client sees a `tool.completed` activity newer than the one
present when Enter was pressed, then sends it with the same `sendTurn` the
server treats as a steer. It never waits for the turn to end.

Evidence, thread `eee61cda-39b5-41b3-8f7c-851806ece136`: every mid-turn user
message left 48 to 54 ms after a `tool.completed` (`aeac5af4` @ 04:06:49.381
after `20eeb3cc` @ 04:06:49.333; `09bba239` @ 04:20:26.203 after `bbae12b4` @
04:20:26.149) and got `thread.turn-start-requested` at the same millisecond as
`thread.message-sent`, while the turn was still `running`.

So today "Queue" is "steer, one tool call later, with an undo window."

Code:

- `apps/web/src/queuedMessageStore.ts` — `isQueuedMessageDue` compares
  `latestToolActivityId` to `queuedAfterToolActivityId`; `take` re-anchors the
  rest so one message leaves per tool boundary.
- `apps/web/src/components/ChatView.tsx:7634` — enqueue when
  `followUpBehavior === "queue"` xor intent `"alternate"` (mod+Enter).
- `apps/web/src/components/ChatView.tsx:8606-8640` — drain effect, active
  thread only.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` ~5162 — a `sendTurn`
  while a turn runs is a steer into the SDK prompt queue.

## Decision 1: steer is immediate (done deciding)

Keep the server-side steer as the only steer. Delete the client-side
tool-boundary buffer.

Why, for output quality:

1. Fewer wasted steps. The SDK reads its prompt queue at the next loop tick,
   so an immediate steer reaches the model right after the current tool
   returns. The client buffer waits for `tool.completed` to cross the socket
   and then sends, by which time the model has already started the next step.
   The model does one more step on stale instructions.
2. No blind spot. During a long reasoning or text stretch with no tool calls
   the client buffer never fires. The immediate steer still lands at the next
   loop tick.
3. One code path. No client timing heuristic that can drift from the SDK's
   real boundaries.

Keep from the old code:

- Hold while an approval or `AskUserQuestion` is pending
  (`queueBlockedByPendingRequest`). A steer that arrives while the model waits
  on an answer can be read as the answer. Show it as a held row with Send now
  and Remove.
- Stop returns held messages to the composer.

Remove:

- `queuedAfterToolActivityId`, `latestCompletedToolActivityId`, the
  re-anchoring in `take`, and the tool-id comparison in `isQueuedMessageDue`.
- Copy that says "queues for the next tool boundary"
  (`ComposerPrimaryActions.tsx:276`, settings description).

## Decision 2: queue lives on the server (decided)

Goal: a queued message goes out only after the current turn is over, and
starts a new turn. Several queued messages go out one at a time, each waiting
for the previous one's turn to finish.

Why server and not client: the current drain effect runs only for the active
thread (`ChatView.tsx:7197`), and the store is in-memory. Queue in thread A,
switch to B, and A never drains; reload and it is gone. A queue that must run
unattended has to live where the turns run.

Decided:

- **Storage**: orchestration events + projection. New events
  `thread.turn-queued` (carries the full turn-start input: message text,
  uploaded attachment refs, model selection, interaction mode, createdAt),
  `thread.turn-queue-removed`. Projection table
  `projection_thread_queued_turns` (thread_id, position, payload). All clients
  render the same rows.
- **Drain**: the decider reacts to `thread.turn-completed` on a thread with a
  non-empty queue and no pending approval or user input by emitting
  `thread.turn-start-requested` for the head entry. Same event the client sends
  today, so provider adapters need no change.
- **Policy**: sequential. One queued message = one new turn. Never combine
  queued messages into a single prompt.
- **Snapshot**: model selection and interaction mode are captured at enqueue
  time and travel with the entry. Changing the composer afterwards does not
  change a queued entry.
- **Queue on an idle thread**: starts immediately (equivalent to a normal
  send).
- **Steer while queue non-empty**: the steer goes immediately; the queue is
  untouched.
- **Turn ends `interrupted` (Stop) or `failed`**: the queue holds. Rows stay,
  marked held, and do not send on their own. Each row keeps Send now and
  Remove. Stop means "wait, something is wrong"; the queue must not fire into
  a broken state or glue separate messages into one composer blob. No
  auto-retry into a broken session.
- **Held queue on the next user send**: when the user sends a new message
  from the composer on a held thread, the held entries stay held. They are
  released only by Send now.
- **Default `followUpBehavior`**: `queue`. Enter = queue, mod+Enter = steer.
- **Client change**: enqueue = upload attachments, then send a
  `thread.turn-queue` command instead of `thread.turn-start`. Delete
  `apps/web/src/queuedMessageStore.ts`; read rows from the projection.
- **Mobile**: renders the rows and Remove; Steer now optional in v1.

- **Row actions while the turn runs**: Steer now (remove from queue, send as
  a steer into the running turn) and Remove (returns text and attachments to
  the composer). **Row actions while held**: Send now (starts a new turn with
  that entry) and Remove.

## Glossary (plain words)

- **Steer**: "change course now." Goes into the running turn right away. The
  model sees it at its next step. Never waits.
- **Queue**: "do this after you finish." Waits until the current turn ends,
  then starts a new turn on its own. Several queued messages run one after
  another.
- **Held**: a queued row that stopped auto-sending because the turn was
  stopped, failed, or is waiting on an approval / question. It sits there
  until you press Send now or Remove.

## Out of scope for v1

- Reordering queued rows by drag.
- Editing a queued row in place (Remove, edit in composer, re-queue instead).
- Auto-retry of a held queue after a failed turn.

## Next step

Write the implementation brief from this file and hand it to a fresh Opus
subagent. Do not start coding before the user says go.
