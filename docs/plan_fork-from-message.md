# Spec: Fork a thread from a past user message

Status: wave 1 implemented (tickets 01-06, last 9ad477eb54). Wave 2 ready-for-agent (grilled 2026-09-23, frontier empty): see "Wave 2" section. Grilled 2026-09-22; frontier empty. No ADR.

## Problem Statement

The only way to "go back" in a thread is **Edit from here**, which reverts the thread in place: history after the chosen message is dropped, the provider session is rolled back, and optionally files are restored. That is destructive — the original continuation is gone. Users who want to try an alternative reply while keeping the original branch have no option, on desktop or mobile.

## Solution

**Fork from here** on any user message creates a _new_ thread whose history is a copy of the source thread up to (but excluding) that message, with the composer pre-filled with that message's text and attachments — the same mental model as Edit from here, without touching the source. The user chooses, per fork, whether the fork shares the source's workspace or gets a fresh worktree with files restored to the checkpoint at that message. The provider session for the fork is created lazily on the fork's first send. A setting controls whether the app jumps into the fork or stays on the source. Mobile gets the same action via a long-press menu on user messages.

## User Stories

1. As a user, I want a "Fork from here" action on every user message in a thread whose provider supports conversation rollback, so that I can branch without losing the original continuation.
2. As a user, I want the fork's history to end just before the chosen message and the composer to be pre-filled with that message (text + attachments), so that forking feels identical to Edit from here except non-destructive.
3. As a user, I want to choose between "Fork in same workspace" and "Fork into new worktree" when forking, so that I decide whether the fork shares files with the source.
4. As a user, I want "Fork into new worktree" to restore files to the checkpoint captured at the chosen message, so that the fork starts from the code state the conversation was at.
5. As a user, I want "Fork into new worktree" to be offered only when it can actually work (git project and a checkpoint exists for that message), so that I am never offered an option that fails.
6. As a user, I want the fork to be named `<source title> (fork)` and live in the same project, so that I can find it next to its source.
7. As a user, I want a setting "After forking: Open the fork / Stay on the source thread" defaulting to _Open the fork_, so that the app matches how I work.
8. As a user, I want to be able to fork a thread while its agent is still running, so that I can branch off an in-progress conversation without waiting.
9. As a user, I want the fork to inherit the source's model, runtime mode, and interaction mode, so that it continues the same conversation with the same setup.
10. As a user, I want forking to be instant, with any provider work happening on my first send in the fork, so that the action never blocks on a provider.
11. As a user, I want a clear banner if the fork could not resume the source's provider session on first send, and my next send to start a fresh session seeded from the copied history, so that a fork is never dead.
12. As a user, I want deleting the source thread to leave the fork intact, and deleting a worktree-fork to prompt about its worktree exactly like any other worktree thread, so that forks are ordinary threads.
13. As a user, I want the fork to display "Forked from <source title>" so that I remember where it came from.
14. As a mobile user, I want a long-press menu on user messages with "Fork from here" offering both fork locations as an action sheet, so that forking works on the phone.
15. As a mobile user, I want the same "After forking" setting on mobile, so that behaviour is consistent per device.
16. As a developer, I want fork to reuse the existing thread-creation and worktree-creation paths, so that there is no second way to create threads.

## Implementation Decisions

- **Visibility gate:** the fork action is shown exactly where Edit from here is shown — user messages in threads whose provider reports `supportsConversationRollback`. One gate for both actions. Providers without that capability get no fork action (revisit later; see Out of Scope).
- **Fork boundary:** the fork's history is every turn strictly before the chosen user message. The chosen message is not copied; its text and attachments are placed in the fork's composer (the existing "prepare reverted message" path is reused for attachment re-materialisation).
- **Fork is a server command**, not a client-side reconstruction: the server copies persisted history into a new thread record created through the existing `thread.create` path, with `historyImport` semantics (no provider session is started). The fork records `forkedFrom: { threadId, turnId }` for display only — no parent/child behaviour, no cascading deletes.
- **Two fork locations, one dialog / action sheet:**
  - _Same workspace_ — new thread with the source's `branch` and `worktreePath`. Files untouched.
  - _New worktree_ — server creates a worktree through the existing worktree-creation path, then restores files from the checkpoint associated with the chosen message into that worktree. Offered only when the project is a git repository and a checkpoint exists for that turn. Restore-in-place into the source's worktree is never offered. The fork thread is created first and the checkout, checkpoint restore and setup script run behind a setup card, exactly as a normal new-worktree thread; a failed step leaves the thread with a failed card and a "Fork again" action (no silent disappearance). Amended after W2-5 — supersedes the earlier "a failure leaves no thread" wording.
- **Lazy provider session:** the fork stores a "resume from source session at turn N" marker. On the fork's first send, the server performs the provider-native session fork (the same mechanism Edit from here uses to roll a session back), but targeting the new thread's session and leaving the source session untouched. The marker is cleared on success.
- **Lazy-fork failure:** if the source session cannot be resumed (expired, provider restarted, source deleted), the send fails with a thread-level banner stating the fork could not resume the original session and that the next send starts a fresh session from the transcript. The marker is replaced by a "seed from history" marker; the next send starts a brand-new session with the copied history supplied as context, then clears the marker.
- **Mid-run source:** forking never inspects or alters the source's run state. History up to N is snapshotted from persisted turns; a source that is mid-turn keeps running.
- **Inheritance:** model selection, runtime mode, interaction mode are copied from the source at fork time.
- **Naming/placement:** title `<source title> (fork)`; same project; ordinary sidebar entry.
- **After-fork setting:** one persisted per-device UI setting, `afterFork: "open" | "stay"`, default `"open"`. `"open"` navigates to the fork immediately; `"stay"` shows a toast with an "Open" action. Web stores it in client settings, which the Settings panels already read, write and reset per device; mobile stores it in its settings persistence. Same key name on both.
- **Mobile message menu:** long-press on a user message opens a native action sheet. Fork items appear only on user messages and only under the same visibility gate. Fork location choice is a second sheet. This menu is the shared home for message-level actions (the copy-message-id plan adds its items here).
- **Deletion:** forks are ordinary threads; deleting a worktree-fork uses the existing worktree-thread delete prompt.

## Testing Decisions

- Good test = one command in, resulting thread state out; no provider process in unit tests.
- **Seam 1 — server fork command:** given a source thread with N turns and a chosen turn k, the fork contains turns `< k`, has `forkedFrom` set, inherits model/runtime/interaction, and the source is byte-identical afterwards. Cases: k = first turn (empty history), k = last turn, source mid-run, source with attachments on turn k.
- **Seam 2 — worktree fork eligibility:** pure function `(isGitProject, hasCheckpointForTurn) → offerNewWorktree`; and the restore path is exercised once with a fixture checkpoint into a temp worktree.
- **Seam 3 — lazy session resolution:** state machine `resumeFromSource → (ok | seedFromHistory) → none`; each transition tested with a faked provider adapter (success, resume failure, seed success).
- **Seam 4 — after-fork setting:** `afterFork` read → navigate vs toast, one test per value, web and mobile.
- Mobile: one render test that the long-press sheet shows fork items only on user messages under the gate.
- Prior art: existing checkpoint-revert tests in the orchestration reactor and Edit-from-here dialog tests in the web chat view.

## Out of Scope

- Fork for providers without `supportsConversationRollback` (some clients do support rollback under a different mechanism; deferred).
- Transcript-seeded forks as a first-class option (only used as the degraded fallback in this spec).
- Restoring files into the _source's_ worktree from a fork.
- Fork from an assistant message; fork tree visualisation in the sidebar; keyboard shortcut.
- Any linkage behaviour between source and fork beyond the display record.
- Live-sync of the after-fork setting across devices.

## Wave 2 (follow-ups, ready-for-agent)

Decisions taken 2026-09-23 after wave 1 landed. Each is independent unless noted.

### W2-1 Codex native fork

- Problem: Codex resumes by cursor into the same native thread, so a rewind on the fork truncates the source's provider-side conversation.
- Decision: fork Codex natively by copying the rollout (session JSONL) to a fresh session id and resuming the copy. If the copy cannot be made, fall back to `seedFromHistory` (transcript seed, no native resume) and surface that in the existing fork-session banner. Expose per-adapter `supportsForkResume`; Claude keeps its existing native fork path.
- Test: adapter-level test that a fork + rewind leaves the source's session untouched; fallback path test.

### W2-2 Fork origin title

- `ThreadForkOrigin` gains `title` captured at fork time. Deleted source renders "Forked from <title>" on both surfaces. Contracts + persistence column + projection read paths.

### W2-3 Mobile parity

- "Forked from" header line on mobile (story 13).
- Delete mobile's duplicate `canForkIntoNewWorktree`; use the shared gate.
- Mobile composer prefill goes through the shared `recallableComposerPrompt`, not raw text.

### W2-4 New-worktree fork runs the setup script

- After checkout, run the project setup program exactly as a normal worktree thread does. Failure is reported through the same activity, and does not delete the fork.

### W2-5 New-worktree fork progress stream

- The fork command returns immediately and progress (checking out / restoring checkpoint / running setup / ready / failed) streams as thread activity; the dialog on web and mobile shows the current stage instead of only disabling buttons. Blocked by W2-4.

### W2-6 `fork.resume.failed` client handling

- Dedicated activity rendering (web + mobile) with the reason, plus the composer retry affordance wired to a fresh session resolution rather than the generic failure rule.

### W2-7 User docs

- `docs/user/forking.md` covering fork-from-here, same-workspace vs new-worktree, after-fork setting, and what happens to provider sessions per provider. Cross-link from composer.md and thread-sidebar.md. Blocked by all of the above.

### Kept as-is

- Seeded transcript cap stays at 8,000 characters (fallback path only).
