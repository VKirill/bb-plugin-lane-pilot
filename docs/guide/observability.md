---
title: Observability
topic: observability
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, observability]
updated: 2026-11-27
sources:
  - src/rooms/owner-waiting/server/index.ts
  - src/rooms/reports/server/index.ts
  - src/rooms/reports/server/handlers/report-workflows.ts
  - src/rooms/reports/server/services/daily-report.ts
  - src/rooms/reports/server/services/review-desk.ts
  - src/rooms/schedule/server/index.ts
  - src/rooms/evolve/server/services/evolve-loop.ts
  - src/rooms/workflow/server/services/run-finished.ts
  - packages/workflow-engine/src/engine-clock.ts
---

# Observability

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

## Daily report and the owner push (Telegram)

Both Telegram digests (`lp.daily-report` and `lp.owner-push`) are registered in `SYSTEM_SCHEDULES` (`src/rooms/schedule/server/services/system-schedules.ts`) and driven by the single engine clock, executing `lp.daily_report` and `lp.owner_push` in `src/rooms/reports/server/handlers/report-workflows.ts` with Env Catalog secrets `TG_AIVECH_BOT`, `TG_OWNER_CHAT_ID`, and `LANE_PILOT_TG_TOPIC`. Event-driven immediate notifications go through `lp.owner-bell` (triggered by `lp.owner.item-created`) with a durable quiet-hours and daily-cap wait.

- The daily report (`lp.daily-report`): runs on the first hourly tick from 09:00 in the owner's time zone (`owner_push.timezone`, Europe/Madrid), once a day. `buildDailyReport` (`src/rooms/reports/server/services/daily-report.ts`) reads the hub database read-only (attempts, workflow runs/steps, token cost or `not_measured`, waiting items, deferrals, outages) and sends the summary. `bb lane-pilot waiting config dry_run=on` logs the text without sending; `lp-metrics.sh [days]` prints attempt metrics on the command line.
- The owner push (`lp.owner-push`): runs every 30 minutes, queries `owner_waiting_digest`, sends the digest, and calls `owner_waiting_ack`. Only items that wake the owner are pushed, nothing in quiet hours (`owner_push.quiet` `23:00-08:00`, `owner_push.timezone` `Europe/Madrid`, `owner_push.enabled` `true`), at most six items named.

## Waiting for the owner

The screen "Waiting for you" (`bb lane-pilot waiting`) holds only what needs a person: a writer's product question unanswered for an hour, workflow runs waiting at a `human` form (72 h default deadline), outages, scheduled-agent blocks, role fallback alerts, and anything posted with `waiting post`. Each item says why it is the owner's, links evidence and gives the exact action. The list is ranked by the cost of putting a row off and capped: the first five rows are «now», the rest fold under «Потом»; the rail badge and the Telegram digest count only «now» rows, and `answered` shows who closed the week's rows (`owner`, `agent`, `lead`). Most rows are decided by the agent itself (`--by agent`); only money, messages to other people, publishing and high-risk changes wait for the owner. Details: [owner waiting](../owner-waiting.md).

## Stage receipts, attempt metrics and per-step workflow facts

- Every stage leaves a receipt and events (`lane_pilot_stage_event`) with a proof kind decided by code (`command`, `file`, `gate`, `receipt`, `schema`, or `advisory` for a model's opinion that never accepts a task alone). `bb lane-pilot attempt <attempt-id>`, `receipt-chain`, `manifest`, and `preship` inspect and assemble them.
- Each workflow step records token, cache-read/write, list-price cost (`packages/models/src/model-prices.ts`, or `not_measured`), duration, `verdict` (`pass|fail|not_run`), `failure_class`, `form_used`, and requested vs answered model in `lane_pilot_wf_step` (`STEP_FACT_FIELDS`).
- `bb lane-pilot metrics <project-id> [--days N] [--json]` prints per attempt the stages passed or failed, seconds per stage, writer tokens and list-price cost. A provider that reports no usage is `not_measured`, never 0; a thread shared by several attempts puts its tokens on the last one and marks the others `partial`.
- The task size metric (files, diff lines, minutes, attempts of each accepted task) rides the acceptance receipt; with five accepted tasks the median warns when a plan slices work far below the project's grain.
- The task page loads the acceptance card (`task_acceptance_card`): the contract, plan against fact per item, stage receipts with proof kind, gate events, what did not run (apart from "no findings"), risk, base commit and cost. `acceptance_stats` reports per project and ISO week first-try and eventual acceptance, attempts per accepted task and failure causes.

## Tasks board and work graph

System, Tasks shows tasks and top-level workflow runs as a board (queued, running, checking, blocked, done) or a list grouped by goal, chat, area or project, refreshed every 8 seconds, with a 24 h or 7 d completion window (`task_board`, `task_card`). A task row shows one square per stage that ran (green, red, running, skipped, round count). The task page shows how the work went: per stage rounds, role, model, turns, time, tokens and cost. "Stages and models" gives per stage green share, median rounds, cost and time over 7, 30 or 90 days (newest 400 tasks). The graph of tasks waiting on each other is shown for an open run. Drills and service projects are hidden unless "Show drills" is on.

## In a chat

A PM chat's info panel (`thread_live`, polled every 8 s) lists the tasks at work with stage, model and minutes and their stage squares; a click opens the steps. A writer or helper thread shows its own task. A thread Lane Pilot has no part in shows nothing.

## Schedule board and the single engine clock

Lane Pilot schedules workflows, errands, named agent routines and host scripts itself (once or on a five-field cron with an IANA time zone). One engine clock (`startClock` in `packages/workflow-engine/src/engine-clock.ts`, wired to `startBoardClock` in `src/rooms/schedule/server/handlers/board-clock.ts`) replaces minute polling: it wakes at the earliest waiting-step deadline or due schedule-board row (`MIN(deadline)`, capped at `CLOCK_BEAT_MS` = 60 s), materialises due runs idempotently by run key (`<schedule id>:<time>`), and handles overdue waits. Board-wide scheduling pauses and resumes via `schedule.paused_all` (`bb lane-pilot schedule pause-all|resume-all`). `bb lane-pilot schedule list|show|history|preview|create|update|pause|resume|run-now|delete`; the board is in the Automation tab.

## Where each signal lives

| Signal | Where |
|---|---|
| Daily Telegram report | `SYSTEM_SCHEDULES` `lp.daily-report` (09:00 Europe/Madrid) |
| What waits for the owner | Screen "Waiting for you", `waiting`, `lp.owner-bell` & `lp.owner-push` |
| Engine clock & waits | `health`, startup clock log, `schedule` board |
| Step facts & model census | `lane_pilot_wf_step` (`STEP_FACT_FIELDS`), `nodeCensus()` |
| Per-attempt cost and stages | `metrics`, `attempt`, task page, acceptance card |
| Acceptance by week | RPC `acceptance_stats`, Acceptance stats view |
| Writer reuse | RPC `writer_reuse_stats` (cold threads per accepted task, area share, median minutes to accept) |
| Memory health | `memory-probe --report`, `memory-tiers`, `memory-conflicts`, `memory-eval` |

## Other signals

`bb lane-pilot money` (month-to-date paid spend against `money.monthly_cap_usd`), `outages` (gaps over five minutes in the plugin heartbeat), `owner-presence` (writers keep off a provider the owner used in the last ten minutes) and the live stability figures in `canary` and the daily report.

## Goal-driven graph and learning loop log events

Engine events added in `LP_EVENTS` (`packages/contracts/src/events.ts`): `lp.workflow.run-finished`, `lp.models.catalog-changed`, and `lp.evolve.threshold-crossed`. Runtime log events emitted by the workflow, evolve, card, specialist, and review-desk rooms:

| Event | Level | Fields |
|---|---|---|
| `wf.finished` | `debug` / `warn` | `run`, `wf`, `status`, `emitted` (or subscriber/emit failure message) |
| `lane-pilot mcp-tier: denied` | `stderr` | `tool`, `tier`, `step` (or invalid `LANE_PILOT_NODE_EFFECT`) |
| `workflow prove` / `workflow prove refused` | `info` / `warn` | `wf`, `model`, `passed` (or refusal `reason`) |
| `run verdict` / `run verdict refused` | `info` / `warn` | `run`, `verdict`, `source`, `reason` (note text never logged) |
| `path save` / `path save refused` | `info` / `warn` | `run`, `draft` (or refusal `reason`) |
| `branch draft` / `branch draft refused` | `info` / `warn` | `graph`, `draft`, `runs` (or refusal `reason`) |
| `project template` / `project template skipped` | `info` / `warn` | `run`, `stages`, `draft` (or skip `reason`) |
| `publish authority` / `publish refused` | `info` / `warn` | `kind`, `draft`, `sha` (or refusal `reason`) |
| `draft guard` / `draft guard owner granted` | `warn` / `info` | `source`, `draft`, `widening`, `workflow`, `by` |
| `graphs.export marked` | `info` | `at` (ISO timestamp) |
| `evolve event` | `info` | `kind`, `wf` |
| `evolve propose` / `evolve propose skipped` | `info` / `warn` | `wf`, `reason` |
| `evolve replay` / `evolve replay aborted` | `info` / `warn` | `hyp`, `cases`, `k`, `pass`, `gain` (or abort `reason`) |
| `evolve decide` / `evolve decide deferred` | `info` / `warn` | `hyp`, `mode`, `counts`, `form` (or open trial `trialId`) |
| `evolve canary` / `evolve rollback` / `evolve publish failed` | `info` / `warn` / `error` | `trial`, `action`, `e`, `wf`, `hyp`, `reason` |
| `judge calibration` | `warn` | `case`, `wf`, `outcome`, `reason`, `model` |
| `card` / `card verified` / `card refused` / `cards load` | `info` / `warn` / `debug` | `id`, `kind`, `key`, `by`, `trust`, `refs`, `found`, `stale` |
| `sp snapshot` | `debug` / `warn` | `case`, `bytes`, `cap`, `dropped` |
| `sp rule` / `sp rule refused` | `info` / `warn` | `id`, `scope`, `state` (or refusal `reason`) |
| `sp autonomy` / `granted` / `revoked` / `grant refused` | `info` / `warn` | `class`, `n`, `wilson`, `kappa`, `state`, `by`, `reason` |
| `attention budget` | `debug` | `decisions_today`, `cap`, `deferred` |
| `loop health` | `debug` | `loop`, `failing`, `metric` |
| `review desk` / `review desk section failed` | `info` / `warn` | `items`, `sections`, `failed`, `section`, `reason` |

## Sources

Where this page's claims start in the code: `src/rooms/owner-waiting/server/index.ts`, `src/rooms/reports/server/index.ts`, `src/rooms/reports/server/handlers/report-workflows.ts`, `src/rooms/reports/server/services/daily-report.ts`, `src/rooms/reports/server/services/review-desk.ts`, `src/rooms/schedule/server/index.ts`, `src/rooms/evolve/server/services/evolve-loop.ts`, `src/rooms/workflow/server/services/run-finished.ts`, `packages/workflow-engine/src/engine-clock.ts`. The deep pages linked above cite the rest.
