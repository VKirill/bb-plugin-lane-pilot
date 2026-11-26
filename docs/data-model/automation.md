---
title: Schedules persistence
type: data-model
created: 2026-10-10
updated: 2026-11-26
status: active
confidence: medium
tags: [data-model, schedules]
sources:
  - src/rooms/schedule/server/services/scheduler.ts
  - src/rooms/schedule/server/handlers/board-clock.ts
  - packages/workflow-engine/src/engine-clock.ts
  - src/rooms/migrations.ts
---

# Schedules persistence

TL;DR: Schedule definitions own recurrence and overlap policy; schedule run rows track each materialized execution driven by the shared workflow engine clock.

## Relationships

```mermaid
erDiagram
  SCHEDULE ||--o{ SCHEDULE_RUN : materializes
```

The schedule store defines a parent/child foreign key (`lane_pilot_schedule_run.schedule_id` → `lane_pilot_schedule.id` with cascading delete).

## `lane_pilot_schedule`

| Field | Meaning |
|---|---|
| `id` | Stable schedule id. |
| `project_id` | Owning BB project (`*` for global schedules). |
| `name`, `description` | Owner-facing label and detail. |
| `kind` | `workflow`, `errand`, `script`, or `agent`. |
| `task_json` | Serialized work definition. |
| `trigger_type` | `cron` or one-time `once`. |
| `cron`, `timezone`, `run_at` | Recurrence expression and time zone, or one-time timestamp. |
| `missed_policy` | `run_once`, `skip`, or `run_all` when a scheduled instant was missed. |
| `missed_limit` | Maximum number of missed occurrences considered. |
| `overlap` | `skip`, `queue`, or `parallel` when a previous run is active. |
| `timeout_sec`, `max_failures` | Per-run time limit and consecutive failure threshold. |
| `state` | `active`, `paused`, or `done`. |
| `pause_reason`, `consecutive_failures` | Pause explanation and failure counter. |
| `cursor_at` | Last schedule cursor time. |
| `created_by`, `created_at`, `updated_at` | Creator identity and epoch-millisecond timestamps. |

The scheduler evaluates due schedules against `engine-clock` (`packages/workflow-engine/src/engine-clock.ts`) and enforces overlap and failure policies (`src/rooms/schedule/server/services/scheduler.ts`).

## `lane_pilot_schedule_run`

| Field | Meaning |
|---|---|
| `id`, `schedule_id` | Run identity and parent schedule; deleting the schedule cascades. |
| `run_key` | Unique idempotency key: schedule plus scheduled instant, or a manual nonce. |
| `scheduled_at` | Due time in epoch milliseconds. |
| `trigger` | `tick`, `catchup`, or `manual`. |
| `status` | `queued`, `running`, `waiting`, `succeeded`, `failed`, `timed_out`, `skipped`, or `canceled`. |
| `reason` | Reason for a skip or failure. |
| `queued_at`, `started_at`, `finished_at`, `deadline_at` | Execution timestamps and deadline, in epoch milliseconds. |
| `ref_kind`, `ref_id` | Type and id of related execution record. |
| `host_id` | Host assigned to the scheduled work. |
| `exit_code`, `output`, `error`, `truncated` | Process result and output handling state. |

A unique `run_key` prevents the same scheduled instant from materializing twice (`src/rooms/schedule/server/services/scheduler.ts`).

## Retention and cleanup

The schedule store declares no automatic run-retention deletion; schedule deletion cascades to its run rows.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot data model overview](../data-model.md)
