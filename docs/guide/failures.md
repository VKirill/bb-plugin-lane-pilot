---
title: Failure handling and stability
topic: failures
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, failures]
updated: 2026-11-06
sources:
  - src/rooms/writer/server/writer-hold.ts
  - src/rooms/stability/server/deploy-drain.ts
  - src/rooms/runs/state-machine.ts
---

# Failure handling and stability

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

## Failure classes and what each one does

Every ended attempt gets a class from `failureClass` (rules on the reason). Each class maps to a MAST-14 bucket recorded in the receipt as `mast` (specification and system design, inter-agent misalignment, task verification, plus `external` for causes MAST does not cover).

| Class | Meaning | Charged | MAST bucket |
|---|---|---|---|
| `task` | The task's own work is red, incomplete or missing a file | yes | verification:incomplete_work |
| `provider` | Model provider fault (the writer's thread ended in an error, the model or tier is not served), empty answer, silent writer | free, next writer | external:provider |
| `merge` | Main moved or conflict; redone on the new main | free | misalignment:base_moved |
| `dirty_base` | Uncommitted edits block the merge; parked | free | external:dirty_base |
| `harness` | Lane Pilot's own fault (`internal_error`, `merge_failed`, `spawn failed`, `reconcile_*`, `attempt_worktree_*`); parked | free | specification:system_failure |
| `infra` | The machine: disk, git lock, host offline, network; parked | free | external:machine |
| `contract` | The PM's to fix: blocked verdict, unsafe path, no git, waiting secret | not retried as is | misalignment:contract_gap |
| `judgment` | A writer question for the PM (`needs_human`) | no attempt spent | misalignment:owner_decision |
| `budget` | A `run.max_*` limit was hit | free, not retried | specification:budget |
| `limit` | Provider plan, quota or credits spent, breaker open | free, next writer | external:provider_limit |
| `reassign` | The PM moved the task to a fresh writer | free | misalignment:reassigned |
| `verification_timeout` | The host killed a check for time | one retry | external:check_timeout |

A red check that carries an environment marker (disk full, permission error of the machine, a dead Studio runner) is `infra`, not `task`. A test runner reporting failing tests stays `task`.

## A writer known to be unavailable gets no attempt

Before an attempt exists, `writerHold` asks whether the writer's provider can work now: the owner at the keyboard of that tool, a usage window, the breaker, the core's allowlist, each with an `until`. `walkWriterChain` spawns the first free member of the primary writer and its fallbacks in the same attempt. When every member is held, `lp-task-pipeline` parks in `admission-wait` with a durable `wakeAt` deadline on the engine clock (woken early by `lp.task.settled`), instead of polling every minute. On the hub's week before writer hold (0.1.478) 61 % of writer attempts had been spent on unavailable writers. Details: [writer hold](../writer-hold.md).

## Interventions and retry limits

| Mechanism | Behaviour | Setting and default |
|---|---|---|
| Interventions | A streak of same-class failures gets that class's move: `free_redo` (merge, reassign), `next_writer` (provider, limit), `narrow_brief` (task, streak of 2: the task stops with a `narrow_brief:` reason and the PM must narrow it), `park` (classes with their own path). | `failure.interventions` on (`off` = plain same retry) |
| Attempts per task | 2 charged attempts, plus up to 3 free retries (merge, infra, harness, limit and others). | fixed (`MAIN_ATTEMPT_LIMIT` 2, `FREE_RETRY_LIMIT` 3) |
| Feedback turns | A failed check goes back to the same writer in its own thread. At most 5 turns or 120 minutes. Two turns with the same failure and the same diff stop early; a red check then passes to the next writer. | fixed (`SESSION_MAX_TURNS` 5, `SESSION_MAX_MS` 120 min) |
| Overall budget | Every fresh writer (retry or fallback) spends one unit; feedback turns do not. Spent: `retry_budget_exhausted`, ends for the PM. | fixed (`TASK_ATTEMPT_BUDGET` 12) |
| Repeated failure | Two consecutive attempts of a family failing the same way (same fingerprint) block the task as `repeated_failure:`. In `lp-task-pipeline`, exhausting `writer` `maxVisits` (3) runs one fresh-worker attempt on the fallback model and then posts an owner inbox item with the failure class. | fixed |
| Retry safety gate | An automatic retry stops when commits or files in the failed attempt's worktree changed after it ended, `.agents/` evidence was rewritten, or a catalog secret sits in the diff. | `writer.retry_safety` on |
| Escalate on red | Send the first red check to the next writer. | `writer.retry_escalate` false |
| Provider handoff | A provider refusal moves to the next writer at once (with no other writer, the same model is tried again); `after_retry` keeps one more attempt of the same model first. A change of model is not an attempt: a provider failure is not charged to the task's two attempts or its retry budget. A stream cut is retried once in the same thread. | `writer.fallback_on_provider_failure` immediate |
| Class cooldowns | Pause after an attempt ends, per class, before the next one: a JSON map class to seconds. | `writer.class_cooldowns` unset; `writer.cooldown_max_ms` 0 (no cap) |
| Task wall-clock cap | A task older than this across attempts and restarts ends as `task_wall_clock`. | `writer.task_wall_clock_min` 720 |
| Verify-pass cap | Failed or rejected verification passes; ends as `verify_passes_exhausted`. | `writer.verify_max_passes` 10 |
| Timed-out check | One retry, then `verification_timeout_budget`; the PM raises `timeout_sec` or narrows the command. | fixed |
| Writer watchdog | `wait-turn` listens for `lp.thread.idle` on a durable deadline, nudges up to `maxVisits` (2), then routes to `stop-silent` and ends `writer_silent_after_nudge` so the task moves to the next writer. | `writer.silence_nudge_min` 20 |
| Unanswered question | `wait-answer` listens for `lp.writer.answered` up to 1 hour, then runs `question-rules`, `second-pilot`, a safe default or an owner inbox item (product decisions end uncharged). | fixed |

## Lane Pilot's fault versus the task's fault

- `harness`, `infra` and `dirty_base` failures park the task in `stability:parked` instead of leaving it blocked. A harness-parked task restarts from its writer stage once a newer Lane Pilot version runs. An infra or dirty-base task restarts after a backoff of 10 minutes doubled per try, up to 3 tries. At most 3 tasks per project restart per sweep. A task that a sibling already took over or accepted is not restarted. A task waiting for a secret restarts when the secret is saved, and is dropped after 24 hours.
- Project breaker: the same harness fingerprint 3 times in 15 minutes opens the project's breaker and holds new writers. After 30 minutes one task is let through to probe. A breaker from another version is discarded, since the fix may have shipped.
- The PM is told once a minute at most, in one message, only about parked tasks that need it. The PM must not diagnose Lane Pilot or redispatch a parked task.
- Automatic retries stop when an assigned PM has been deleted or archived. A temporary error reading the PM preserves the parked ticket for the next sweep; a run without an assigned PM keeps its existing retry behavior.
- Disk guard: writers wait with `disk_low` while a machine has less than max(3 GB, min(5 GB, 5% of the disk)) free. Lock guard: a stale `index.lock` or an unwritable index is `infra`; merges queue behind the checkout lock.

## Providers

- Provider breaker (`packages/resilience`): 3 failures in 10 minutes open a provider and model pair. A plan, quota or credits refusal opens it at once, until the reset time the error named, else for a 5 minute cooldown, then one half-open trial call.
- Automatic role fallback (`workflow-role-fallback.ts`): when a workflow node hits an auth, quota or subscription failure, the role switches to its fallback across active graphs and posts one deduplicated owner inbox item per role.
- Usage skip: `usage.skip_percent` (default 90; 0 turns it off) moves a writer off a provider whose usage window is nearly spent, using BB's `provider-usage` sources. Without a source nothing is held.
- BB's `provider-retry` queued retries are cancelled for a thread Lane Pilot has given up on, so the abandoned thread cannot redo the work.

## Deploys, reloads and recovery

- Deploy drain: before a reload, calls that write a checkout (merge, worktree, rollback, install) and acceptance checks wait, and running ones finish. A drain nobody turned off ends after 20 minutes. The manifest gives the lifecycle drain 300,000 ms. `deploy_drain` RPC is the manual switch (`docs/deployment.md`, `docs/gotchas.md`).
- Reload recovery (`reconcile`): a writer thread found idle or errored with its attempt still running is resumed in the same thread with its saved workspace. A canceled attempt closes as canceled. A missing thread ends as a spawn failure; an ambiguous scan blocks. Startup recovery runs one `reconcile` pass at boot, `engine.resume()` re-arms waiting steps and processes up to 25 overdue deadlines per tick, and `nextRunDeadline` wakes overdue runs on the single engine clock.
- Hub watchdog (`docs/watchdog.md`, `scripts/hub-watchdog.sh`): knocks on BB every 15 seconds, suspects after 8 silences, kills a hung server and lifts it with doubling pauses (30, 60, 120 s). After 5 lifts in an hour it stops and asks for a human.
- Hook time limits: a BB hook that is late is recorded in diagnostics.

## Drills, canary and quality checks

- Canary (`scripts/lp-canary.sh`, RPC `canary_status`, triggered by event `lp.attempt.finished` -> `lp.canary-check`): a new version is watched during its first 20 attempts or 120 minutes. It trips at more than 5% own faults with at least 3 faults; the PMs are told once. Drill and sandbox projects are excluded. The script prints rollback commands and never runs them.
- Deploy drill (`scripts/lp-drill.sh`, `scripts/lp-drill.py`): a live regression check that `bb-plugin-push` runs with `--quick` on every deploy. Scenarios: `guard_hash`, `deferrals`, `checkers`, `memory_paths`, `helper_providers`, `parallel3`, `conflict`, `main_moved`, `provider_limit`, `reload`, `provider`, `nogit`, `nogit_repo`, `watchdog`. The receipt goes to `.agents/runs/drills/<date>.json`. Exit 1 means a scenario failed.
- Checkers scorecard (`docs/checkers.md`, `bb lane-pilot checkers score|scorecard|drill|defects`): known defects are planted into accepted candidates and each checker's hit rate is scored per class. The `checkers` drill scenario also blinds the ownership checker and requires red. `decideCodeCritic` recommends `medium` only if the critic caught at least 60% of escapes, judged at least 8, and flagged at most 30% of clean candidates.

## Run budgets and the owner

- Run budgets `run.max_attempts`, `run.max_wall_minutes`, `run.max_tokens`, `run.max_children` are unset by default (and workflow steps/runs also honor node/run token, USD, wall-second and repeat limits). A running writer or graph step is stopped at its limit; attempt and child limits refuse the next spawn. The reason `run_budget_exceeded:` is class `budget`: free, not retried. A task `appetite.minutes` stops a writer past it; `appetite.tokens` is a forecast.
- Owner waiting (`docs/owner-waiting.md`): one screen and `bb lane-pilot waiting` hold what the owner's own words started and what callers post. `lp.owner-bell` reacts to `lp.owner.item-created` with a durable wait over quiet hours (`owner_push.quiet` 23:00-08:00, `owner_push.timezone` Europe/Madrid) and daily caps, while `lp.owner-push` sends a 30-minute Telegram digest (`owner_push.enabled` true), never repeating after an acknowledgement.

## Sources

Where this page's claims start in the code: `src/rooms/writer/server/writer-hold.ts:27-47`, `src/rooms/stability/server/deploy-drain.ts:2-22`, `src/rooms/runs/state-machine.ts:1-21`. The deep pages linked above cite the rest.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Settings and experimental features](settings.md)
