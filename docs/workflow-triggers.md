---
title: Workflow triggers
type: component
created: 2026-10-30
updated: 2026-11-26
status: active
confidence: medium
tags: [workflow, triggers, events]
sources:
  - src/rooms/workflow/server/services/workflow-triggers.ts
  - src/rooms/workflow/server/services/workflow-triggers-live.ts
  - packages/contracts/src/events.ts
  - packages/workflow-engine/src/inbox.ts
---

# Workflow triggers (W9)

A workflow starts in four ways (`TriggerSource = "manual" | "schedule" | "event"` plus PM `chat` routing). Every start checks runnability, required inputs, declared requirements (`requires`), and an active PM chat where needed (`src/rooms/workflow/server/services/workflow-triggers.ts`).

| Trigger | Who starts it | How |
|---|---|---|
| `chat` | the PM | `lane_pilot_route` picks a published workflow; `lane_pilot_run_workflow` starts it. |
| `manual` | the owner | **Run** in the Workflows tab (`workflow_run` RPC with `source: "manual"`). `liveTrial: true` starts a `tested` workflow for its first live run. |
| `schedule` | Lane Pilot's schedule board | Syncs schedule triggers into `lane_pilot_schedule` / `lane_pilot_wf_trigger` and fires via `engine-clock` (no BB script automations). |
| `event` | Hub event inbox (`LP_EVENTS`) | `emitEvent` appends to `lane_pilot_wf_inbox`, wakes waiting steps, and starts matching published graphs. |

## Schedule

```json
"triggers": [{ "type": "schedule", "cron": "0 9 * * 1-5", "projectId": "proj_...", "inputs": { "query": "cats" } }]
```

`cron` has five fields (minute hour day-of-month month day-of-week); `timezone` is an IANA name (falling back to the owner's configured zone). `projectId` names the project whose PM chat runs it; `inputs` supply scheduled run inputs.

`workflow-triggers` syncs each published schedule trigger onto Lane Pilot's schedule board (`lane_pilot_wf_trigger` links the workflow trigger to its `lane_pilot_schedule` row, `src/rooms/workflow/server/services/workflow-triggers.ts`), rather than creating official BB Automations. When a run is due, the shared `engine-clock` (`packages/workflow-engine/src/engine-clock.ts`) claims it and invokes the workflow trigger starter.

## Events (`LP_EVENTS` and `lane_pilot_wf_inbox`)

Published graphs declaring `{ "type": "event", ... }` triggers and steps waiting in `builtin:wait` are driven by the append-only event inbox (`lane_pilot_wf_inbox`, `packages/workflow-engine/src/inbox.ts`). Calling `emitEvent` inserts idempotently into `lane_pilot_wf_inbox`, wakes matching waiting steps in `WorkflowEngine` with attempt fencing, and starts matching event-triggered workflows (`src/rooms/workflow/server/services/workflow-triggers.ts`, `packages/contracts/src/events.ts`: `THREAD_IDLE`, `PM_TURN_ENDED`, `MEMORY_RECORD_COMMITTED`, `TASK_SETTLED`, `WRITER_ANSWERED`, `PERMIT_REQUESTED`, `WRITER_PROCESS_EXITED`, `WRITER_WORK_HANDED_BACK`, `OWNER_ITEM_CREATED`, `ATTEMPT_FINISHED`, `ATTEMPT_MERGED`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Schedule board: Lane Pilot's own scheduler](schedule-board.md)
