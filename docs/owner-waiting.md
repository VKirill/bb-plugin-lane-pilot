---
title: Waiting for the owner
type: component
created: 2026-10-22
updated: 2026-10-30
status: active
confidence: medium
tags: [sma, owner, telegram, ui, morning-list]
sources:
  - src/rooms/owner-waiting/items.ts
  - src/rooms/owner-waiting/push.ts
  - src/rooms/owner-waiting/cli.ts
  - src/rooms/owner-waiting/migrations.ts
  - src/rooms/owner-waiting/server/rpc.ts
  - src/rooms/owner-waiting/ui/owner-waiting-board.tsx
  - src/rooms/policy/morning.ts
  - src/rooms/writer/server/question-timeout.ts
  - src/rooms/workflow/server/pm-notice.ts
  - scripts/lp-morning.sql
  - scripts/lp-metrics-daily.sh
  - scripts/lp-owner-push.sh
  - tests/owner-waiting.test.ts
  - tests/owner-waiting-ui.test.tsx
  - tests/owner-push-script.test.ts
  - tests/policy/morning.test.ts
---

> [!important] Since 2026-10-29 the owner does take part in one wait
> With `owner.words` on (default), a task that names the owner's promise waits up to six hours for his «yes» before its merge; his answer comes through this same inbox. Everything below stays as said: only what his own words started and the inbox items are listed; the morning list reports the rest.
> The screen holds only what the owner's own words started (learned items from his messages, e.g. a reminder) and whatever a caller posts to the inbox. Waiting rules, deferrals, held memory conflicts and night repairs are the system's and are not listed; the morning list is a report (`src/rooms/policy/morning.ts`). The history block at the foot describes the earlier design.

# Waiting for the owner

TL;DR: one screen («Ждут владельца», in the System group of the Lane Pilot page), one command (`bb lane-pilot waiting`), one line in the daily report and one short Telegram message hold what the owner's own words started and what callers post to his inbox. Each item says what it is, why it is his, where the evidence is and the exact action. One thing does wait for an answer: a task gated by `owner.words` holds its merge up to six hours for the owner's yes (owner decision 2026-10-29); after that it blocks instead of asking again. Everything else goes on without him.

## Purpose

SMA D0-3 («Waiting for you» card, «one wait, one message»). The night policy (`docs/night-policy.md`) sends proposals and owner-only decisions to the morning list; the screen keeps the two sources that remain — the learned items his own messages produced, and the `lane_pilot_owner_item` inbox.

## What is read

`collectOwnerWaiting` (`src/rooms/owner-waiting/items.ts:135`) reads existing tables; it decides nothing. Rows of sandbox projects are filtered out (`items.ts:90-98`).

| Source | Rows | Wakes the phone | The action |
|---|---|---|---|
| `learning` | `lane_pilot_learning_item` in state `pending_owner` — learned items from his own messages (`items.ts:66-75`) | no | `bb lane-pilot learning accept\|reject <id>` |
| `writer` | a writer's question to a human that went unanswered for `writer.question_wait_min` (default two hours): with `writer.auto_return` on, the second pilot could not answer or narrow it and the PM chat was cold (`src/rooms/writer/server/second-pilot.ts`, no wake); with it off, a product question (`src/rooms/writer/server/question-timeout.ts`, wake) | by the row's `wake` | answer in the task's objective and send the task again |
| `phase` | owner-word turns of a running phase (`src/rooms/phase/server/driver.ts:378`, `:1032`) | by the row's `wake` | the row's own `actions` |
| `workflow` | the end of a run that has no PM chat to tell (`src/rooms/workflow/server/pm-notice.ts:106-124`) | on failure | the row's own `actions` |
| `wall` | a wall class that ran out of moves (`src/rooms/wall/service.ts:232`) | no | the row's own `actions` |
| `outage` | an outage window (`src/rooms/outage/server/outage.ts:23`) | no | the row's own `actions` |
| `schedule` | a scheduled agent's outcome or block (`src/rooms/schedule/server/schedule-agent-actions.ts:79`) | on `urgent` | the row's own `actions` |
| anything posted | `postOwnerItem` or `bb lane-pilot waiting post '<json>'` (`items.ts:104-113`) | by the row's `wake` | the row's own `actions` |

Beside the list the screen shows **what went red overnight** (attempt states of the last 24 hours with the attempt ids as evidence) and **what was accepted** (attempts, rules put on trial, rules confirmed) — `overnight` (`items.ts:117-133`).

## The item shape (the contract with the posters)

`OwnerItem` is the stable shape: `key` (stable, a repeat is the same waiting), `source`, `kind`, `projectId`, `what`, `why` it is the owner's, `since`, `wake`, `evidence[]` (`{kind: attempt|task|run|file|note|message|command|text, ref, label?}`) and `actions[]` (`{id, label, cli, rpc?, needsOwnerMessage?, hint?}`; with `rpc` the screen draws a button, without it the command is shown to copy). The night loop writes rows with `postOwnerItem` (or `bb lane-pilot waiting post '<json>'`) and closes them with `closeOwnerItem` (`waiting close <key> --by …`); the screen, the daily line and the Telegram digest pick them up with no further code (`items.ts:104-113`, `:115`). The text of built-in items is Russian (the owner's language); the screen chrome has EN and RU.

## Telegram

Lane Pilot has no Telegram sender of its own. The hub's script `scripts/lp-owner-push.sh` (a BB automation every 30 minutes, installed next to the daily report's `tg.env`) asks the RPC `owner_waiting_digest`, sends the text with the daily report's bot and then calls `owner_waiting_ack` with the keys. The rules are in code (`src/rooms/owner-waiting/push.ts`) and tested:

- only items with `wake` push; the rest wait on the screen and in the daily report;
- one waiting, one message: an acknowledged key never pushes again; a send that failed is not acknowledged, so the next run tries again;
- quiet hours, default 23:00-08:00 in Europe/Madrid: nothing is sent, nothing is lost, the items go out together in the first digest after;
- at most six items are named, the rest are counted.

Settings (rows `owner_push.enabled|quiet|timezone` of the global level, edited on the Self-improvement page, see `docs/self-improvement-settings.md`; the old table `lane_pilot_owner_config` is the fallback for a field with no row): `bb lane-pilot waiting config [enabled=on|off] [quiet=HH:MM-HH:MM] [timezone=Europe/Madrid]`, or the Telegram block at the foot of the screen. `quiet=00:00-00:00` means no quiet hours.

## Daily report

`scripts/lp-morning.sql:19` adds the line «От твоих сообщений — N» — open inbox rows plus learned items `pending_owner`. `composeMorningList` (`bb lane-pilot policy morning`) computes the same lines; `tests/policy/morning.test.ts` keeps the two equal. The script creates `lp_morning(since, now)`; a hub database without the new tables loses only this line.

## Data

Three tables, appended at the end of `migrations` (`src/rooms/owner-waiting/migrations.ts`): `lane_pilot_owner_item` (the inbox), `lane_pilot_owner_push` (keys already sent), `lane_pilot_owner_config`.

## RPC and commands

`owner_waiting` (the list), `owner_waiting_digest`, `owner_waiting_ack`, `owner_waiting_config`; `bb lane-pilot waiting [--json] | digest | ack <key>… | config … | post '<json>' | close <key> --by …`.

## Limits

- Evidence links are references (attempt id, note id, command); the screen does not open an attempt or a note on click.

## History: the pre-2026-10-22 design

Before the owner left the loop the screen also held `deferral_overdue` (an open deferral whose term passed, settled by a new term from the owner's own message), `deferral_term` (deferrals `needs_owner_term`), `memory_conflict` (held conflicts of `lane_pilot_memory_conflict`, settled with `--keep a|b|both|none`) and `rule_proposal` (proposals in state `proposed` with accept/reject buttons). None of these is a source any longer: deferrals without a term count as unproven in their project's phases, a held memory conflict is settled by the newer note, and rule proposals go on trial by themselves.
