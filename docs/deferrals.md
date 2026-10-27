---
title: Register of deferrals
type: component
created: 2026-10-22
updated: 2026-10-22
status: active
confidence: medium
tags: [deferral, sma, drill, owner]
sources:
  - src/rooms/deferral/migrations.ts
  - src/rooms/deferral/store.ts
  - src/rooms/deferral/verify.ts
  - src/rooms/deferral/due.ts
  - src/rooms/deferral/service.ts
  - src/rooms/deferral/seed.ts
  - src/rooms/deferral/skips.ts
  - src/rooms/deferral/cli.ts
  - src/rooms/deferral/server/rpc.ts
  - src/rooms/anamnesis/owner-messages.ts
  - scripts/lp-drill.py
  - scripts/lp-metrics-daily.sh
  - tests/deferral-skips.test.ts
  - src/rooms/storage/database.ts
  - src/rooms/relay/server/relay.ts
---

> [!important] Only a human sets a term (Fable's recheck of 0.1.336, E8)
> The owner takes no part in the loop, so no code or agent gives a term. An entry the code or an agent opens (seeded skips, plan decisions, a memory conflict, `bb lane-pilot defer <what> --kind … --reason …`) is born **open, no term**: no due date, never overdue. A put-off check of a project with no term from the owner counts as **unproven** in that project's phase acceptance (the `limits_acknowledged` line) until an agent closes it with evidence. A wall in the backlog opens no deferral at all (its backlog item and the owner's morning line are enough). Only a message of the owner that names a date sets a term (`--owner-msg`); an agent cannot set or move one. The 21 rows seeded on 2026-10-22 carry the old default of 14 days (2026-11-05, `due_source default_14d`); the store reads them as open, no term and does not rewrite them, so none of them turns overdue.

# Register of deferrals

TL;DR: A mandatory check that is put off is written in one table; only a date in the owner's own message is a term, and when that passes the deploy drill is red. Without such a term the entry is open, no term, and counts as unproven in its project's phases until it is closed with evidence.

## Purpose

SMA rule 5 (Maslov): a deferred mandatory check lives in one register and its term comes from a human; an agent never sets or extends it, and `it.todo` without a date is a silent hole. The scope is the mandatory checks and decisions (drill scenarios, skipped tests, gates, plan decisions), not agents' own notes. There is no owner login and no confirmation form: the code checks that the date was really said, which protects against a made-up date.

## Data

`lane_pilot_deferral` has the id, `project_id` (null for a global entry), `what`, `kind` (`drill_scenario`, `skipped_test`, `gate`, `plan_decision`), `area`, `due_at`, `due_source`, `owner_ref`, `owner_quote`, `state`, the history of earlier terms, `closed_at` and `closed_by` (`src/rooms/deferral/migrations.ts:10-27`). The migrations are spread at the end of the list, after the OpenCode v2 settings update (`src/rooms/storage/database.ts:339-340`).

`owner_ref` is JSON: thread id, event sequence, input index, SHA-256 of the checked text and the message's own time (`src/rooms/deferral/store.ts:12`). States: `open`, `overdue`, `closed`, and `needs_owner_term` for an entry nobody has given a term to yet (`src/rooms/deferral/store.ts:9`). Open entries whose `due_at` passed are stored as `overdue` on every read (`src/rooms/deferral/store.ts:47-49`).

## Writing a term

`bb lane-pilot defer <what> --kind … --owner-msg <threadId>#<seq> [--due 2026-11-05]`, the same through the RPC `deferral_defer` (`src/rooms/deferral/cli.ts:3-8`, `src/rooms/deferral/server/rpc.ts:8-12`). `defer <dfr_id> --owner-msg …` sets the first term of an entry or moves it.

1. The reference is read through the SDK: `threads.get` for the thread and `threads.events.list` for the one `client/turn/requested` event at that sequence (`src/rooms/deferral/verify.ts:31-37`, `:57-65`).
2. It counts only when the owner-message filter of the anamnesis room accepts it (`src/rooms/deferral/verify.ts:40`). That filter keeps an event whose `initiator` is `user`, with no `senderThreadId` (an agent's message), no system label and no retry mark, in a thread that is visible, top level, not made by a plugin and not deleted (`src/rooms/anamnesis/owner-messages.ts:38-62`). A refusal says which of these failed (`src/rooms/deferral/verify.ts:41-51`).
3. The date comes from the text: `--due` must be a day the text names, a single named date is taken without `--due`, several need `--due`, and a message with no date gives no term and is refused (there is no default). Recognised forms: ISO, `5.11.2026` and `5.11`, `5 ноября`, `Nov 5`, `через 14 дней / 2 недели / месяц`, `in 14 days`, `завтра`, `до пятницы`, `by Friday` (`src/rooms/deferral/due.ts:41-98`). Days are UTC and a term runs to the end of its day.
4. Moving a term of an entry that already has one needs a newer owner message than the one that gave it; the same message or an older one is refused (`src/rooms/deferral/service.ts:79-83`). The earlier term goes to the history (`src/rooms/deferral/store.ts:69-74`).

`bb lane-pilot defer-close <id> --evidence …` closes an entry; the evidence must say what closes it (`src/rooms/deferral/service.ts:108-116`). `bb lane-pilot deferrals [--project P] [--state S]` lists them (`src/rooms/deferral/service.ts:118-141`).

## What turns red

- **Deploy drill.** The `deferrals` scenario is in `--quick`. It reads `deferral_list` over `bb plugin rpc call lane-pilot`, fails on every overdue entry with the commands to close it or to get a new date, and fails on a skipped test that cites an id the register lacks or holds closed (`scripts/lp-drill.py:700-731`). A plugin that does not have the RPC yet passes with a note once (`scripts/lp-drill.py:695-697`, `:718-720`).
- **Skipped tests.** Every `skip`, `todo`, `skipIf`, `xit` and `xdescribe` in `tests/` and `packages/*/tests/` needs `// deferral:<id>` on its line or the line above (`src/rooms/deferral/skips.ts:35-48`). `tests/deferral-skips.test.ts` fails on a bare skip, and on an id that is neither seeded nor a runtime id.
- **PM.** The task-result message to the PM ends with the overdue and open entries of its project and the global ones, before it promises a date (`src/rooms/deferral/service.ts:144-159`, `src/rooms/relay/server/relay.ts:371-375`, `:597`). Entries with no term are listed there as «open, no term».
- **Daily Telegram line.** `lp-metrics-daily.sh` adds «Отсрочки: просрочено N, открыто K, нужен срок от владельца M» and names up to three overdue entries (`scripts/lp-metrics-daily.sh:26-30`).

## First entries

On start the plugin writes, once, one `skipped_test` entry per skipping test file (16) and the five waiting decisions of `.agents/plans/2026-10-05-harness-engineering-gaps.md`, all `needs_owner_term` with no owner message and no term (`src/rooms/deferral/seed.ts:18-40`, `:43-52`). They are never counted overdue; they are the owner's morning list: «нужен срок от владельца». An owner message sets a term with `bb lane-pilot defer <dfr_seed_…> --owner-msg …`.

## Limits

- Dates are read from the text by a small explicit parser; a form that is not listed names no date.
- A plugin-made thread is never an owner thread, so a decision given only there cannot carry a term.
- The same owner message may open several entries; only moving a term needs a newer one.
