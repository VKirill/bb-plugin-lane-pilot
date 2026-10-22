---
title: Waiting for the owner
type: component
created: 2026-10-22
updated: 2026-10-22
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
  - scripts/lp-morning.sql
  - scripts/lp-metrics-daily.sh
  - scripts/lp-owner-push.sh
  - tests/owner-waiting.test.ts
  - tests/owner-waiting-ui.test.tsx
  - tests/owner-push-script.test.ts
  - tests/policy/morning.test.ts
---

# Waiting for the owner

TL;DR: one screen («Ждут владельца», in the System group of the Lane Pilot page), one command (`bb lane-pilot waiting`), one line in the daily report and one short Telegram message hold everything only the owner can decide. Each item says what it is, why it is his, where the evidence is and the exact action. Nothing waits for an answer: the work goes on.

## Purpose

SMA D0-3 («Waiting for you» card, «one wait, one message»). The night policy (`docs/night-policy.md`) sends proposals and owner-only decisions to the morning list, but the list was a CLI command and three lines in the daily report; deferrals without a term (21 on the hub), held memory conflicts and the night loop's output had no screen, so they were invisible.

## What is read

`collectOwnerWaiting` (`src/rooms/owner-waiting/items.ts`) reads existing tables; it decides nothing.

| Source | Rows | Wakes the phone | The action |
|---|---|---|---|
| `deferral_overdue` | an open deferral whose term passed (the deploy drill is red) | yes | a new term needs the owner's own message (`bb lane-pilot defer <id> --owner-msg <threadId>#<seq>`), or close it with evidence |
| `memory_conflict` | held conflicts of `lane_pilot_memory_conflict` (their `memory_conflict` deferral entry is not shown twice) | yes | `bb lane-pilot memory-conflict-settle <id> --keep a\|b\|both\|none --evidence …` |
| `rule_proposal` | rule proposals in state `proposed`, every project | no | buttons accept / reject: the RPC `decide_rule_proposal` of the Rules tab |
| `learning` | learned items `pending_owner` | no | `bb lane-pilot learning accept\|reject <id>` |
| `deferral_term` | deferrals `needs_owner_term` (the seeded skipped tests and plan decisions) | no | the same term command; folded on the screen |
| anything the night loop posts | `lane_pilot_owner_item`, open rows | by the row's `wake` | the row's own `actions` |

A deferral's term is never a button: the code reads the owner's message and takes the date from its text, so an agent cannot set it (`docs/deferrals.md`). The screen shows the command with a hint on how to find the thread id and the event number (`bb lane-pilot events-list <thread-id>`).

Beside the list the screen shows **what went red overnight** (attempt states of the last 24 hours with the attempt ids as evidence) and **what was accepted** (attempts, rules put on trial, rules confirmed).

## The item shape (the contract with the night loop)

`OwnerItem` is the stable shape: `key` (stable, a repeat is the same waiting), `source`, `kind`, `projectId`, `what`, `why` it is the owner's, `since`, `wake`, `evidence[]` (`{kind: attempt|task|run|file|note|message|command|text, ref, label?}`) and `actions[]` (`{id, label, cli, rpc?, needsOwnerMessage?, hint?}`; with `rpc` the screen draws a button, without it the command is shown to copy). The night loop writes rows with `postOwnerItem` (or `bb lane-pilot waiting post '<json>'`) and closes them with `closeOwnerItem` (`waiting close <key> --by …`); the screen, the daily line and the Telegram digest pick them up with no further code. The text of built-in items is Russian (the owner's language); the screen chrome has EN and RU.

## Telegram

Lane Pilot has no Telegram sender of its own. The hub's script `scripts/lp-owner-push.sh` (a BB automation every 30 minutes, installed next to the daily report's `tg.env`) asks the RPC `owner_waiting_digest`, sends the text with the daily report's bot and then calls `owner_waiting_ack` with the keys. The rules are in code (`src/rooms/owner-waiting/push.ts`) and tested:

- only items with `wake` push (an overdue deferral, a memory conflict, night rows); rule proposals, learned items and deferrals without a term wait on the screen and in the daily report;
- one waiting, one message: an acknowledged key never pushes again; a send that failed is not acknowledged, so the next run tries again;
- quiet hours, default 23:00-08:00 in Europe/Madrid: nothing is sent, nothing is lost, the items go out together in the first digest after;
- at most six items are named, the rest are counted.

Settings (stored in `lane_pilot_owner_config`, no catalog row): `bb lane-pilot waiting config [enabled=on|off] [quiet=HH:MM-HH:MM] [timezone=Europe/Madrid]`, or the Telegram block at the foot of the screen. `quiet=00:00-00:00` means no quiet hours.

## Daily report

`scripts/lp-morning.sql` gained a fourth line, «Ещё ждут владельца: отсрочек без срока — N, просроченных — N, конфликтов памяти — N, от ночного цикла — N», next to the three lines that were there (rules and learned items waiting, red overnight, accepted). `composeMorningList` (`bb lane-pilot policy morning`) computes the same four lines; `tests/policy/morning.test.ts` keeps the two equal. The script now creates `lp_morning(since, now)`; a hub database without the new tables loses only the fourth line.

## Data

Three tables, appended at the end of `migrations` (`src/rooms/owner-waiting/migrations.ts`): `lane_pilot_owner_item` (the night loop's inbox), `lane_pilot_owner_push` (keys already sent), `lane_pilot_owner_config`.

## RPC and commands

`owner_waiting` (the list), `owner_waiting_digest`, `owner_waiting_ack`, `owner_waiting_config`; `bb lane-pilot waiting [--json] | digest | ack <key>… | config … | post '<json>' | close <key> --by …`.

## Limits

- Evidence links are references (attempt id, note id, command); the screen does not open an attempt or a note on click.
- A memory conflict is settled by command, not by button: it needs the owner's line of evidence.
- The 21 seeded deferrals are listed under a folded heading; they stay there until the owner gives each a term.
