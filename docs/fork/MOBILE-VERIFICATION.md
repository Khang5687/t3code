# Mobile verification guide for fork features

Manual device/simulator pass for the fork-only features that landed on `fork-main`
without a device run. Written for someone (or an agent) with no context on how they
were built. Each section says what the feature is, where the code lives, the exact
steps, what "pass" looks like, and what to collect when it does not.

This page is a procedure, not a tracker. Record outcomes as issues (see
[issue-tracker](../agents/issue-tracker.md)); do not tick boxes here.

## Setup

1. Boot a simulator / connect a device. Ensure the native client matches the tree:
   `node scripts/mobile-native-client.ts ensure <ios|android> <device-id>` (see
   [`apps/mobile/README.md`](../../apps/mobile/README.md)). A JS change that "does
   nothing" on device is usually a stale native client or a `file:` module copy —
   see [mobile-development](../internals/mobile-development.md).
2. Start the server (`vp dev` from the repo root) and Metro for `apps/mobile`.
   Pair the phone with the server. You need one project that is a **git repository**
   (new-worktree fork is only offered there) and one that is not.
3. Have at least one thread per provider you can log in to. Fork is only offered on
   providers that report `supportsConversationRollback`: **Claude, Codex, OpenCode**.
   Cursor, Grok and Antigravity must show _no_ fork action — that is correct, not a bug.
4. Web at the same server is the reference behaviour: if unsure whether mobile is
   wrong, do the same step on web and compare.

Useful debug tool that also landed: long-press any settled message → **Copy debug ref**
gives `thread=…;turn=…;message=…`. Paste that into every bug report.

## 1. Slash anywhere (skill menu mid-prompt)

- Spec: [`docs/plan_slash-anywhere.md`](../plan_slash-anywhere.md)
- Code: `packages/shared/src/composerTrigger.ts` (`detectComposerTrigger`; shared with
  web), `apps/mobile/src/features/threads/ComposerCommandPopover.tsx`,
  `composerSlashSkillSearch.ts`.
- Behaviour: `/` after whitespace anywhere in the prompt opens the **skill** menu
  (same list and insertion as `$`). `/` at line start still opens the command menu
  (`/model` etc). `/` inside a word or path never triggers.

| Step                                 | Expect                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type `fix this /`                    | Skill menu opens, filters as you type                                                                                                                         |
| Pick a skill                         | `$skill-name ` inserted at the cursor, rest of text intact                                                                                                    |
| Type `see /etc/hosts`                | No menu after `see /`? **Menu opens** (rule is "whitespace before `/`"). Typing `etc…` filters to nothing; Space or Esc dismisses and leaves the text literal |
| Type `a/b` or `https://x`            | No menu                                                                                                                                                       |
| Type `/` on an empty line            | Command menu (model, etc), not the skill menu                                                                                                                 |
| Menu open, tap outside / press Space | Dismisses, `/` stays in text                                                                                                                                  |
| Keyboard covers popover?             | Popover must stay visible above the keyboard on small screens (known risk: mid-message popover position)                                                      |

Bug report: device, keyboard (system / third-party), exact text typed, screenshot of popover.

## 2. Copy message ID / debug ref (long-press menu)

- Spec: [`docs/plan_copy-message-id.md`](../plan_copy-message-id.md)
- Code: `apps/mobile/src/features/threads/thread-message-menu.ts` (actions +
  eligibility), `ThreadFeed.tsx` (`copyTextWithHaptic`), formatter shared from
  `@t3tools/client-runtime/timeline-debug-ref`.

| Step                                                          | Expect                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Long-press a settled user message                             | Menu has **Copy message ID** and **Copy debug ref**                               |
| Long-press a settled assistant message                        | Same two items                                                                    |
| Copy message ID, paste                                        | Bare id, nothing else                                                             |
| Copy debug ref, paste                                         | `thread=<id>;turn=<id>;message=<id>` — `turn=` may be absent on rows with no turn |
| Long-press a streaming (unsettled) message                    | No copy items                                                                     |
| Long-press a tool/activity row that groups several activities | No copy items (only single-activity rows have an id)                              |
| Haptic + toast on copy                                        | Present on iOS; Android haptic may be device-dependent                            |

## 3. Fork from message

- Spec: [`docs/plan_fork-from-message.md`](../plan_fork-from-message.md), user doc
  [`docs/user/forking.md`](../user/forking.md)
- Code: `apps/mobile/src/features/threads/use-fork-thread-from-message.ts`,
  `thread-message-menu.ts` (fork items + gate), `worktree-setup-card.tsx`,
  `worktree-setup-sheet.tsx`, `ThreadRouteScreen.tsx` ("Forked from" line),
  `apps/mobile/src/features/settings/SettingsThreadsRouteScreen.tsx` (After forking).
  Shared logic in `packages/client-runtime/src/threadFork.ts` and
  `composerPromptHistory.ts`. Server: `apps/server/src/orchestration/ForkWorkspace.ts`,
  `decider.ts` (`thread.fork`).

### 3a. Gate

| Step                                                            | Expect                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| Long-press a **user** message on a Claude/Codex/OpenCode thread | **Fork from here** (same workspace) offered              |
| Same, project is a git repo and the message has a checkpoint    | **Fork into new worktree** also offered                  |
| Same, project is not a git repo                                 | Only same-workspace fork                                 |
| Long-press an assistant message                                 | No fork items                                            |
| Cursor / Grok / Antigravity thread                              | No fork items                                            |
| While the agent is still running mid-turn                       | Fork items still offered (mid-run fork is a requirement) |

### 3b. Same-workspace fork

| Step                                                                       | Expect                                                                                                                                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fork from message N                                                        | New thread appears, titled from the source, history = everything **before** message N                                                                            |
| Composer of the fork                                                       | Prefilled with message N's text; @-mentions/attachments: text only is expected on mobile (known gap, see below)                                                  |
| Header of the fork                                                         | "Forked from <source title>" line; tapping opens the source. Source deleted → plain text, no link                                                                |
| Source thread                                                              | Unchanged: no messages lost, still runnable                                                                                                                      |
| Send in the fork (first send)                                              | Reply continues the conversation with the copied context (server resumes the source session at that turn). No "could not resume" banner on a healthy provider    |
| Send in the fork after the provider was restarted / source session expired | One banner: fork could not resume the original session; next send starts a fresh session seeded from the transcript. Retry is a normal send, not an error dialog |
| Codex thread                                                               | Same visible result; internally Codex uses its own `thread/fork` — check the source thread's Codex session keeps working afterwards                              |
| Fork twice from the same message                                           | Two independent forks                                                                                                                                            |
| Fork of a fork                                                             | Works; boundary is the chosen message in the fork                                                                                                                |

### 3c. New-worktree fork

| Step                                 | Expect                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Fork into new worktree               | Thread appears **immediately** with a setup card: checking out → restoring checkpoint → running setup script → ready                       |
| Composer while card is in progress   | Sending is refused (server rejects turns until ready)                                                                                      |
| Setup script prints / is slow        | Progress visible on the card; **Cancel** works and marks the card cancelled                                                                |
| Restore or setup fails               | Card shows the error and **Fork again**; thread is _not_ deleted. (Old plan text said "leaves no thread" — that was superseded, see plan.) |
| Kill and reopen the app during setup | Card resumes its state from the server, not stuck on a stale stage                                                                         |
| Delete the fork thread               | Its worktree is offered for removal like any worktree thread; source worktree untouched                                                    |
| Files in the new worktree            | Match the checkpoint of message N, not the source's current files                                                                          |

### 3d. "After forking" setting

Settings → Thread behavior → **After forking**: _Open the fork_ (default) / _Stay on
the source_.

| Step                             | Expect                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Default                          | Fork opens the new thread                                                                        |
| Stay on the source               | You remain on the source; a banner/toast offers **Open**; tapping it navigates                   |
| Change setting, kill app, reopen | Setting persisted (mobile preferences, not server-synced — web and mobile can differ, by design) |

### Known gaps on mobile (not bugs, do not re-report)

- Composer prefill after fork carries text only; @-mention context records and
  attachments are not re-materialised on mobile (web does re-attach).
- Setup-script "async" flag is not honoured for forks: the card waits for the script.
- No toast framework on mobile: "Stay on the source" uses a banner, web uses a toast.

## 4. Agents panel sorting — n/a on mobile

Mobile has no Agents panel; nothing to verify.

## 5. Live rebind of listen interfaces

Mobile is a **client** only: when the server's interface/port changes it gets a
`serverMoved` event and shows a banner ("server moved", reconnect to the new URL).
Mobile cannot change listen interfaces.

| Step                                                                                  | Expect                                                                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| On desktop, change the port under Settings → Connections while the phone is connected | Phone shows a "server moved" banner with the new address; reconnect works                      |
| Change only the interface set, same port                                              | Phone reconnects silently (no banner; the URL is unchanged)                                    |
| Phone was paired via QR to the _old_ port                                             | Its saved server URL is stale — re-pair or edit the URL. This is a known limitation, not a bug |

## Reporting

For every failure record: device + OS version, provider, the **Copy debug ref** output,
the exact steps, a screenshot/recording, and the server log line if any
(`vp dev` output). File it through the fork's issue tracker with the feature name
from this page as the label.
