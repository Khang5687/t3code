# Spec: Copy a timeline row's ID for debugging

Status: implemented (web 01 29ef6dcda0 / mobile 02 f46565be31). Grilled 2026-09-22; frontier empty. No ADR.

## Problem Statement

When something goes wrong in a thread, finding the corresponding record in the event log / JSONL means reading IDs out of devtools or the store. There is no way to grab a message's ID from the UI, on desktop or mobile.

## Solution

Every timeline row that has a persisted, stable ID gets a hover-only ghost "copy ID" icon (desktop) and menu items in the message long-press menu (mobile). Click copies the bare ID. A tooltip shows `thread / turn / message`. A secondary action copies a single grep-able debug reference line containing all three.

## User Stories

1. As a developer, I want a hover-only copy-ID icon on every timeline row with a stable ID (user, assistant, activity, approval), so that I can copy the ID of exactly the row that misbehaved.
2. As a developer, I want click to copy the bare ID, so that the common case is one action with no formatting to strip.
3. As a developer, I want the tooltip to show `thread / turn / message`, so that I can eyeball IDs without copying.
4. As a developer, I want shift-click to copy a debug reference `thread=<id>;turn=<id>;message=<id>`, so that one paste locates the row in logs.
5. As a developer, I want rows without a persisted ID (streaming placeholders) to show no icon, so that I never copy a transient value.
6. As a developer, I want the icon always available with no setting, so that it is there the moment I need it.
7. As a mobile developer, I want "Copy message ID" and "Copy debug ref" in the long-press menu on every row with a stable ID, with the usual copy haptic, so that mobile debugging is as easy as desktop.

## Implementation Decisions

- **Which rows:** any timeline row whose underlying record has a persisted ID. Rows that are still streaming or have a synthetic client-only ID show nothing until they settle.
- **Affordance (web):** a ghost icon in the row's existing hover-action area (same placement family as the existing copy/revert buttons on user messages), visible on hover/focus only. Uses the existing anchored copy-success / copy-error toasts.
- **Payloads:** click → bare row ID. Shift-click → `thread=<threadId>;turn=<turnId>;message=<rowId>` on one line. `turn` is omitted for rows that have no turn (e.g. thread-level activity). The formatter is a pure function shared by web and mobile.
- **Tooltip:** `thread / turn / message` with each ID, plus the hint "click to copy · shift-click for debug ref".
- **Mobile:** two items — "Copy message ID", "Copy debug ref" — in the message long-press menu introduced by the fork-from-message plan, on every row with a stable ID (fork items remain user-message-only). Copy goes through the existing haptic copy helper.
- **No setting, no developer mode.**

## Testing Decisions

- Good test = record in, string out.
- **Single seam:** the debug-ref formatter: full triple; missing turn; ordering and separator fixed. Plus one row-eligibility case: streaming row → no ID exposed.
- One render test per platform is acceptable but not required: web hover shows the icon on a settled row and not on a streaming row; mobile sheet lists the two items.
- Prior art: existing anchored-copy toast tests and `copyTextWithHaptic` tests on mobile.

## Out of Scope

- Copying full row payloads / JSON.
- Deep-linking to a row by ID; searching the timeline by ID.
- A developer-mode setting.
