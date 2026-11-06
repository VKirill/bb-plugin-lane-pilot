---
title: Observability
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, observability]
updated: 2026-11-06
sources:
  - src/rooms/owner-waiting/server/index.ts
  - src/rooms/schedule/server/index.ts
  - src/rooms/wall/server/index.ts
---

# Observability

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

## Morning summary and the wall journal

The night loop writes a journal (`lane_pilot_wall_*` tables) of failure classes, repairs, hunts and spend against the night cap. `bb lane-pilot wall morning` and `bb lane-pilot policy morning` print the morning list: rules put on trial or confirmed, what went red in the last 24 hours, what was accepted, deferrals, plus three wall lines (classes and spend; repairs merged, accepted, held, rolled back; hunts, backlog and re-runs).

## Daily report and the owner push (Telegram)

Lane Pilot has no Telegram sender of its own. Two shell scripts in `scripts/` run on the hub, are installed by hand next to `~/.config/lp-metrics/tg.env`, and post through the Telegram Bot API:

- `lp-metrics-daily.sh` runs as a BB automation at 09:00 Europe/Madrid. It reads the hub database read-only and sends a Russian-language daily report for real projects on the current version (stability headline, failure origins, sandbox and old-version lines, usage coverage, deferrals), then appends `lp-morning.sql`, `lp-wall-morning.sql`, graph coverage and outage lines when those files are installed. `DRY_RUN=1` prints it. `lp-metrics.sh [days]` prints the same metrics on the command line.
- `lp-owner-push.sh` runs every 30 minutes. It asks the RPC `owner_waiting_digest`, sends the text, then calls `owner_waiting_ack`. Only items that wake the owner are pushed, one message per waiting, nothing in quiet hours (`owner_push.quiet` `23:00-08:00`, `owner_push.timezone` `Europe/Madrid`, `owner_push.enabled` `true`), at most six items named.

## Waiting for the owner

The screen "Waiting for you" (`bb lane-pilot waiting`) holds only what needs a person: learned items pending the owner, a writer's product question unanswered for an hour, phase turns, workflow runs without a PM chat, wall classes out of moves, outages, scheduled-agent blocks and anything posted with `waiting post`. Each item says why it is the owner's, links evidence and gives the exact action. Nothing waits for an answer: the work goes on. The list is ranked by the cost of putting a row off and capped: the first five rows are «now», the rest fold under «Потом»; the rail badge and the Telegram digest count only «now» rows, and `answered` shows who closed the week's rows (owner, agent, lead, janitor). Most rows are decided by the agent itself (`--by agent`); only money, messages to other people, publishing and high-risk changes wait for the owner. Details: [owner waiting](../owner-waiting.md). It also shows what went red overnight and what was accepted.

## Stage receipts, attempt metrics and the acceptance card

- Every stage leaves a receipt and events (`lane_pilot_stage_event`) with a proof kind decided by code (`command`, `file`, `gate`, `receipt`, `schema`, or `advisory` for a model's opinion that never accepts a task alone). `bb lane-pilot passport <attempt-id>`, `receipt-chain`, `manifest`, `pr-passport` and `preship` assemble them.
- `bb lane-pilot metrics <project-id> [--days N] [--json]` prints per attempt the stages passed or failed, seconds per stage, writer tokens and list-price cost (a price table, also on a subscription). A provider that reports no usage is `not_measured`, never 0; a thread shared by several attempts puts its tokens on the last one and marks the others `partial`.
- The task size metric (files, diff lines, minutes, attempts of each accepted task) rides the acceptance receipt; with five accepted tasks the median warns when a plan slices work far below the project's grain.
- The task page loads the acceptance card (`task_acceptance_card`): the contract, plan against fact per item, stage receipts with proof kind, gate events, what did not run (apart from "no findings"), risk, base commit and cost. `acceptance_stats` reports per project and ISO week first-try and eventual acceptance, attempts per accepted task and failure causes.

## Tasks board and work graph

System, Tasks shows tasks and top-level workflow runs as a board (queued, running, checking, blocked, done) or a list grouped by goal, chat, area or project, refreshed every 8 seconds, with a 24 h or 7 d completion window (`task_board`, `task_card`). A task row shows one square per stage that ran (green, red, running, skipped, round count). The task page shows how the work went: per stage rounds, role, model, turns, time, tokens and cost. "Stages and models" gives per stage green share, median rounds, cost and time over 7, 30 or 90 days (newest 400 tasks). The graph of tasks waiting on each other is shown for an open run. Drills and service projects are hidden unless "Show drills" is on.

## In a chat

A PM chat's info panel (`thread_live`, polled every 8 s) lists the tasks at work with phase, stage, model and minutes and their stage squares; a click opens the steps. A writer or helper thread shows its own task. A thread Lane Pilot has no part in shows nothing.

## Schedule board

Lane Pilot schedules workflows, errands, named agent routines and host scripts itself (once or on a five-field cron with an IANA time zone). `schedule-board-tick` runs every minute, materialises due runs idempotently by run key (`<schedule id>:<time>`) and supervises them; a host silent ten minutes past its deadline fails the run. `bb lane-pilot schedule list|show|history|preview|create|update|pause|resume|run-now|delete`; the board is in the Automation tab.

## Where each signal lives

| Signal | Where |
|---|---|
| Daily Telegram report | Hub script `lp-metrics-daily.sh` (09:00 Europe/Madrid) |
| What waits for the owner | Screen "Waiting for you", `waiting`, Telegram push |
| Morning list and wall lines | `policy morning`, `wall morning`, appended to the daily report |
| Per-attempt cost and stages | `metrics`, task page, acceptance card |
| Acceptance by week | RPC `acceptance_stats`, Acceptance stats view |
| Writer reuse | RPC `writer_reuse_stats` (cold threads per accepted task, area share, median minutes to accept) |
| Memory health | `memory-probe --report`, `memory-tiers`, `memory-conflicts`, `memory-eval` |
| Bench and baseline | `bench status`, `bench baseline`, `bench gate` |
| Self-improvement status | System, Self-improvement page |

## Other signals

`bb lane-pilot money` (month-to-date paid spend against `money.monthly_cap_usd`), `outages` (gaps over five minutes in the plugin heartbeat), `owner-presence` (writers keep off a provider the owner used in the last ten minutes), `bench baseline` and the live stability figures in the daily report.

## Sources

Where this page's claims start in the code: `src/rooms/owner-waiting/server/index.ts:1-5`, `src/rooms/schedule/server/index.ts:3-9`, `src/rooms/wall/server/index.ts:2-6`. The deep pages linked above cite the rest.
