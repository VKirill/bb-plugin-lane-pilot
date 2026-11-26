---
title: Run RPC contract
type: component
created: 2026-10-16
updated: 2026-10-30
status: active
confidence: medium
tags: [rpc, runs, tasks]
sources:
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/contracts/index.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/runs/server/handlers/runs-rpc.ts
  - src/rooms/runs/server/services/task-board.ts
  - src/rooms/settings/server/handlers/rpc/settings.ts
  - src/rooms/storage/database.ts
---

# Run RPC contract

TL;DR: `rpcRuns` supplies the task board, task, acceptance, and run cards, native thread selection, paged run history, and stage receipts.

## Purpose

`rpcRuns` declares strict request and response shapes for the run screens and cards; its handler factories are registered via the room registry (`src/rooms/contracts/rpc-runs.ts`, `src/rooms/contracts/index.ts`, `src/rooms/core/server/rpc.ts`).

## How it works

1. BB validates each request against its method schema. Board requests may omit project id and default completed-task lookback to 24 hours; list requests require project id, offset and limit. Card, stage and native-thread requests require their identifying ids (`src/rooms/contracts/rpc-runs.ts`).
2. `task_board` asks `buildTaskBoard` for project or all-project items and maps attempt/stage state to board column and phase (`src/rooms/runs/server/services/task-board.ts`).
3. `task_card` reads a task/run card (null when missing) and attaches worker/PM threads and child threads (`src/rooms/contracts/rpc-runs.ts:57-70`, `src/rooms/runs/server/handlers/runs-rpc.ts`). `task_acceptance_card` returns `AcceptanceCard | null` (`src/rooms/contracts/rpc-runs.ts:12-43`, `:77-80`).
4. `get_run_card` selects the run and per-task latest attempts, exposes validated relative `checkLog` paths, and includes `background` (`lp.after-accept` memory stage) failures/blocks for accepted tasks (`src/rooms/contracts/rpc-runs.ts:82-90`).
5. `native_thread`, `list_runs`, `list_run_stages`, and `get_stage_result` read native selection KV state, paged project/section runs (`pinOpen` pinning), and stage receipt bodies (`src/rooms/settings/server/handlers/rpc/settings.ts`, `src/rooms/storage/database.ts`).

| Method branch | Inputs and outcomes | Failure behavior |
|---|---|---|
| Board phase mapping | Accepted/canceled → done; queued → planning or waiting; live → checking or writing; failed → retrying; remainder → blocked, stuck, or closed. | Display mapping only (`src/rooms/runs/server/services/task-board.ts`). |
| Board | Optional `projectId`; `doneHours` 1–720 (default 24). | SQL errors reject; thread title lookup failures become null titles. |
| Task / acceptance / run card | Identifying run/task ids. | Missing records return null (`src/rooms/contracts/rpc-runs.ts`). |
| Run page & stage results | Required offset and limit 1–200; stage lookups distinguish `found:false` from `result:null`. | Invalid bounds fail strict Zod validation. |

## Business rules

`task_card` and `task_acceptance_card` are nullable when absent; stage summaries omit result JSON while `get_stage_result` loads a single body (`src/rooms/contracts/rpc-runs.ts`). Check-log paths are validated relative to the writer workspace before exposure.

## Public API or commands

Procedures include `task_board`, `thread_live`, `task_card`, `work_file_read`, `task_acceptance_card`, `get_run_card`, `native_thread`, `list_runs`, `list_run_stages`, and `get_stage_result` (`src/rooms/contracts/rpc-runs.ts:45-90`).

## Gotchas

- `native_thread` does not catch errors while parsing a stored selection; only agent id derivation and effective profile compilation have local fallback handling (`src/rooms/runs/server/handlers/runs-rpc.ts`).
- `list_runs` section lookup errors propagate rather than returning an empty page (`src/rooms/settings/server/handlers/rpc/settings.ts`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
