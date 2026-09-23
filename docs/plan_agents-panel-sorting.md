# Spec: Agents panel — status grouping, stable order, sort control

Status: implemented (01 c1c86800a2 / 02 a7cf2a4bd4). Grilled 2026-09-22; frontier empty. No ADR.

## Problem Statement

The Agents panel lists direct spawns in a fixed, arbitrary order. Working, waiting, and long-finished agents are interleaved, and a batch of settled runs pushes the live ones out of view. There is no way to change the order.

## Solution

Rows are grouped by status — Working, then Waiting, then Settled — and stay put while running. Within a group the default order is stable (first seen); the Settled group orders by most recent activity and collapses when it gets long. A small sort dropdown lets the user pick another order, remembered across sessions.

## User Stories

1. As a user, I want working agents at the top, so that I see what is running right now.
2. As a user, I want agents waiting on me next, so that I can unblock them.
3. As a user, I want settled agents below the live ones, so that they do not hide active work.
4. As a user, I want rows to not jump while an agent streams, so that I can click one without it moving.
5. As a user, I want a row to move only when its status changes, so that reorders mean something.
6. As a user, I want the Settled group to show the most recent first, so that the run I just finished is at hand.
7. As a user, I want the Settled group collapsed with a count once it has more than five rows, so that the panel stays short.
8. As a user, I want to expand the collapsed Settled group, so that I can still open old runs.
9. As a user, I want a sort dropdown (Recent activity / Duration / Tokens / Name), so that I can order rows for what I am doing.
10. As a user, I want my sort choice remembered, so that I do not re-pick it every launch.
11. As a user, I want children of a sub-agent to stay under their parent, so that the tree still reads as a tree.
12. As a user, I want the group headers to show a count, so that I can see the shape of the run at a glance.
13. As a developer, I want ordering to be a pure function, so that it is testable without rendering.

## Implementation Decisions

- **Status groups:** `Working` (running, starting), `Waiting` (needs user input / approval), `Settled` (completed, failed, cancelled, interrupted, superseded). Existing "Stopped" labelling for cancelled/interrupted is kept for the row badge; the group is called Settled.
- **Default order inside groups:** Working and Waiting by `firstSeenAt` ascending (stable; no reorder on token/activity events). Settled by `completedAt` descending.
- **Reorder triggers:** only status transitions. Activity timestamps affect the Settled group only.
- **Sort control:** dropdown with `status` (default), `recent-activity`, `duration`, `tokens`, `name`. Non-default sorts still keep the three groups; the sort applies inside each group. Persisted in the web UI state store (localStorage-backed).
- **Collapse:** Settled group collapses by default when it has more than 5 rows; collapsed state is per-session, not persisted. Header shows `Settled (N)`.
- **Tree:** ordering is applied to direct spawns only; nested children keep their existing order under their parent.
- **Module:** a pure `orderDirectSpawns(rows, sort)` in client-runtime state, consumed by the Agents panel component. The component owns only the dropdown, the collapse toggle, and persistence wiring.

## Testing Decisions

- Good test = give fixtures in, assert order out; no DOM for ordering logic.
- **Seam 1:** `orderDirectSpawns` unit tests — grouping, stability under activity updates, Settled recency, each sort mode, ties broken by `firstSeenAt`.
- **Seam 2:** one render test on the Agents panel — dropdown changes order and the choice survives a remount via the UI state store; Settled collapses at >5.
- Prior art: existing client-runtime reducer tests and the panel's existing render tests.

## Out of Scope

- Filtering/search of agents.
- Drag-to-reorder.
- Persisting the collapsed state.
- Changing status vocabulary or the row badge visuals.

## Further Notes

Screenshot that prompted this: `CleanShot 2026-09-21 at 13.36.31@2x.png`.
