---
title: Register of deferrals
type: component
created: 2026-10-22
updated: 2026-11-14
status: active
confidence: medium
tags: [deferral, sma, drill, owner]
sources:
  - src/rooms/deferral/migrations.ts
  - src/rooms/deferral/models/deferral.ts
  - src/rooms/deferral/models/due.ts
  - src/rooms/deferral/models/seed.ts
  - src/rooms/deferral/server/services/verify.ts
  - src/rooms/deferral/server/services/deferral-service.ts
  - src/rooms/deferral/server/handlers/deferral-cli.ts
  - src/rooms/deferral/server/handlers/deferral-rpc.ts
  - src/rooms/deferral/skips.ts
  - src/rooms/contracts/owner-messages.ts
  - scripts/lp_drill/scenes/deferrals.py
  - src/rooms/reports/server/services/daily-report.ts
  - src/rooms/reports/server/handlers/report-workflows.ts
  - tests/deferral-skips.test.ts
  - src/rooms/migrations.ts
  - src/rooms/relay/server/services/relay.ts
---

> [!important] Only a human sets a term (Fable's recheck of 0.1.336, E8)
> The owner takes no part in the loop, so no code or agent gives a term. An entry the code or an agent opens (seeded skips, plan decisions, a memory conflict, `bb lane-pilot defer <what> --kind … --reason …`) is born **open, no term**: no due date, never overdue. Only a message of the owner that names a date sets a term (`--owner-msg`); an agent cannot set or move one. The 21 rows seeded on 2026-10-22 carry the old default of 14 days (`due_source default_14d`); the store reads them as open, no term and does not rewrite them, so none of them turns overdue.

# Register of deferrals

TL;DR: A mandatory check that is put off is written in one table; only a date in the owner's own message is a term, and when that passes the deploy drill and baseline preflight turn red. Without such a term the entry is open, no term.

## Purpose

SMA rule 5: a deferred mandatory check lives in one register and its term comes from a human; an agent never sets or extends it, and `it.todo` without a date is a silent hole.

## How it works

1. An entry is born **open, no term**: an agent's `defer` without `--owner-msg` creates it `needs_owner_term` (`src/rooms/deferral/server/services/deferral-service.ts`); `--due` without `--owner-msg` is refused.
2. The owner's message sets the term: the reference is verified as a real owner message, the date is parsed from the text, and the entry becomes `open` — or `overdue` at once when the date already passed.
3. Every read sweeps first (`sweepOverdue`): an open entry whose `due_at` passed is stored `overdue` (`src/rooms/deferral/models/deferral.ts`).
4. `defer-close` closes an entry; the evidence must say what closes it.
5. Overdue and term-less entries surface in the deploy drill, baseline preflight (`src/rooms/baseline/server/services/baseline-service.ts`), the skipped-test scanner, the PM's task-result message, and the daily Telegram report.

| State | Set when | Written by |
|---|---|---|
| `needs_owner_term` | Born without a term: an agent, the code, or the seed. | `deferral-service.ts` (`byAgent`, `open`). |
| `open` | An owner message verified and a date parsed from its text. | `deferral-service.ts` (`defer`). |
| `overdue` | The term's day passed: at creation, or swept on every read. | `defer` / `sweepOverdue`. |
| `closed` | `defer-close` with evidence of what closed it. | `deferral-service.ts` (`close`). |

## Data

`lane_pilot_deferral` holds id, `project_id`, `what`, `kind` (`drill_scenario`, `skipped_test`, `gate`, `plan_decision`), `area`, `due_at`, `due_source`, `owner_ref`, `owner_quote`, `state`, term history, `closed_at`, and `closed_by` (`src/rooms/deferral/migrations.ts`).

## Writing a term

`bb lane-pilot defer <what> --kind … --owner-msg <threadId>#<seq> [--due 2026-11-05]`, the same through RPC `deferral_defer` (`src/rooms/deferral/server/handlers/deferral-cli.ts`, `src/rooms/deferral/server/handlers/deferral-rpc.ts`).

1. The reference is read through `threads.get` and `threads.events.list` for `client/turn/requested` at that sequence (`src/rooms/deferral/server/services/verify.ts`).
2. It counts only when the owner-message filter (`src/rooms/contracts/owner-messages.ts`) accepts it (initiator `user`, no `senderThreadId`, visible top-level non-plugin thread).
3. Dates are parsed by `src/rooms/deferral/models/due.ts`.

`bb lane-pilot defer-close <id> --evidence …` closes an entry; `bb lane-pilot deferrals [--project P] [--state S]` lists them.

## What turns red

- **Deploy drill & baseline.** The `deferrals` drill scenario fails on overdue entries (`scripts/lp_drill/scenes/deferrals.py`) and baseline preflight blocks task start (`overdue_deferral`) on overdue entries.
- **Skipped tests.** Every `skip`, `todo`, `skipIf`, `xit` and `xdescribe` in `tests/` and `packages/*/tests/` needs `// deferral:<id>` (`src/rooms/deferral/skips.ts`, `tests/deferral-skips.test.ts`).
- **PM & Daily Telegram line.** PM notices (`src/rooms/relay/server/services/relay.ts`) and `daily-report` (`src/rooms/reports/server/services/daily-report.ts`) surface overdue and open entries.
