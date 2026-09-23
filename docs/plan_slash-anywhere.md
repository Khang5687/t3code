# Spec: `/` opens the skill/command menu anywhere in the prompt

Status: implemented (web 01 c1c86800a2, mobile 02 3ba611b886). Grilled 2026-09-22; frontier empty. No ADR.

## Problem Statement

Typing `/` at the start of a message opens the command menu (commands, skills, provider commands). Typing `/` in the middle of a prompt — "I want to invoke the command /" — opens nothing, so the user has to remember exact skill names.

## Solution

A `/` typed after whitespace (or at line start) opens the same menu the `$` skill trigger opens today: skills and provider slash-commands. Selecting an item inserts it exactly the way `$` does. Standalone-only commands (`/model`, `/plan`, `/compact`, …) keep working at line start and are not offered mid-prompt.

## User Stories

1. As a user, I want `/` after a space to open the menu, so that I can pick a skill mid-sentence.
2. As a user, I want `/` at the start of a line to keep behaving as it does today, so that nothing I rely on changes.
3. As a user, I want `/` inside a word or path (`src/foo`, `a/b`, `https://…`) to never open the menu, so that typing paths is not interrupted.
4. As a user, I want mid-prompt `/` to show only skills and provider commands, so that mode-changing commands do not appear where they make no sense.
5. As a user, I want selecting an item to insert the token plus a trailing space, so that I can keep typing.
6. As a user, I want the inserted result to be identical to what `$` inserts, so that the two triggers are interchangeable.
7. As a user, I want Space or Esc to close the menu and leave the `/` as text, so that I can type a literal slash.
8. As a user, I want the menu to filter as I type after the `/`, so that I can narrow quickly.
9. As a developer, I want the trigger detection to be a pure function, so that the edge cases are table-testable.

## Implementation Decisions

- **Trigger rule:** in `detectComposerTrigger`, if the current token starts with `/` and the token starts at line start, keep the existing `slash-command` trigger (unchanged). Otherwise, if the token starts with `/` and is preceded by whitespace, return a `skill` trigger with the query after the `/` — i.e. mid-prompt `/` is an alias of the currency-symbol (`$`) skill trigger. A `/` preceded by a non-whitespace character returns no trigger.
- **Menu contents mid-prompt:** the same item set the `skill` trigger shows today (skills + provider slash-commands). No standalone commands.
- **Insertion:** unchanged — the existing skill replacement path (`applyPromptReplacement` with trailing-space extension). No new segment kind, no new trigger kind.
- **Dismiss:** unchanged; same as `@` and `$`.
- **Line-start `/` continues to be evaluated first**, so existing standalone-command detection (`/plan`, `/default`, compact availability) is untouched.

## Testing Decisions

- Good test = text + cursor in, trigger out; no component rendering.
- **Single seam:** `composer-logic` unit tests, table-driven: line-start `/` → `slash-command`; `foo /` → `skill` with empty query; `foo /rev` → `skill` query `rev`; `(see /x` → `skill` query `x` (rule: `/` after whitespace fires, no punctuation special-casing); `src/foo` → no trigger; `https://x` → no trigger; second line starting with `/` → `slash-command`; `$rev` and `/rev` mid-prompt produce identical triggers except kind is the same.
- Prior art: existing `detectComposerTrigger` tests in `composer-logic.test.ts`.

## Out of Scope

- Making standalone commands available mid-prompt.
- Changing the menu UI or its ranking.
- Mobile composer (it shares the logic; no separate work).

## Further Notes

Line-start `/` currently matches on the whole line prefix (`^\/(\S*)$`); that stays so `/model` followed by arguments keeps working.
