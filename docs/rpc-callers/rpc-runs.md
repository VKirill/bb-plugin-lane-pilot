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
  - src/rooms/runs/server/rpc/runs.ts
  - src/rooms/runs/server/task-board.ts
  - src/rooms/settings/server/rpc/settings.ts
  - src/rooms/storage/database.ts
---

# Run RPC contract

TL;DR: `rpcRuns` supplies the task board, task and run cards, native thread selection, paged run history, and stage receipts.

## Purpose

`rpcRuns` declares strict request and response shapes for the run screens and cards; its handler factories are registered as part of the app RPC contract (`src/rooms/contracts/rpc-runs.ts:4-30`, `src/rooms/contracts/index.ts:18-27`, `src/rooms/core/server/rpc.ts:31-34`).

## How it works

1. BB validates each request against its method schema. Board requests may omit project id and default completed-task lookback to 24 hours; list requests require project id, offset and limit. Card, stage and native-thread requests require their identifying ids (`src/rooms/contracts/rpc-runs.ts:30-102`).
2. `task_board` asks `buildTaskBoard` for project or all-project items and a done-since timestamp. The builder includes latest attempts that are still live or changed during the lookback and maps attempt/stage state to board column and phase (`src/rooms/runs/server/task-board.ts:63-75`, `:89-123`). The handler caches PM thread titles for five minutes, queries missing titles in parallel, swallows thread lookup failures to null, then returns the items with nullable titles (`src/rooms/runs/server/rpc/runs.ts:171-181`).
3. `task_card` reads a task/run card. Missing card returns null. Otherwise it describes worker and PM threads, lists each worker's child threads, and returns the card with its thread tree; BB thread lookup failures produce null metadata or empty children (`src/rooms/runs/server/rpc/runs.ts:182-201`).
4. `get_run_card` selects the run and, per task, the attempt with the highest number (ties: newest created_at, then id). Missing run returns null. It parses task title from contract JSON with task id fallback, exposes a check-log path only when it is relative, has no `..` path segment, and both writer host and workspace are known, and adds `background` — the after-acceptance stages (memory, project log, docs) whose current receipt is failed or blocked — to an accepted task (`src/rooms/runs/server/rpc/runs.ts:207-244`).
5. `native_thread` loads the thread's stored selection from KV. Missing selection returns null; a present value is schema parsed, agent type falls back to selected agent id, and effective agent compilation failure falls back to the short agent id description (`src/rooms/runs/server/rpc/runs.ts:246-263`).
6. `list_runs` expands an optional section to its ancestor chain, loads a page of newest-first project runs, and applies project settings for those scopes when building run views. The database can pin open runs outside the offset/limit page when `pinOpen` is true (`src/rooms/settings/server/rpc/settings.ts:262-266`, `src/rooms/storage/database.ts:1557-1561`).
7. `list_run_stages` returns receipt summaries without result bodies. `get_stage_result` distinguishes a missing receipt (`found:false`) from an existing receipt with a null result (`found:true,result:null`) (`src/rooms/settings/server/rpc/settings.ts:267-268`, `src/rooms/storage/database.ts:804-826`).

| Method branch | Inputs and outcomes | Failure behavior |
|---|---|---|
| Board phase mapping | Accepted/canceled attempts map to done; queued work can be planning or waiting; live work can be checking or writing; recent failed work is retrying; remaining cases are blocked, stuck, or closed. | This affects display column/phase, not the underlying attempt state (`src/rooms/runs/server/task-board.ts:89-114`). |
| Board | Optional `projectId`; `doneHours` is an integer 1–720, default 24. | SQL/task-board errors reject; thread title lookup errors are swallowed into a null title (`src/rooms/contracts/rpc-runs.ts:31-42`, `src/rooms/runs/server/rpc/runs.ts:171-181`). |
| Task card | Nonempty run id and nullable task id. | Missing card returns null; thread lookup failures do not remove the card (`src/rooms/contracts/rpc-runs.ts:44-57`, `src/rooms/runs/server/rpc/runs.ts:182-201`). |
| Run card | Nonempty run id. | Missing run returns null. Unsafe or incomplete check-log references are returned as `checkLog:null` (`src/rooms/contracts/rpc-runs.ts:64-79`, `src/rooms/runs/server/rpc/runs.ts:207-244`). |
| Native thread | Nonempty thread id. | Missing KV selection returns null; invalid stored selection schema or KV failure rejects. Agent compilation alone is caught and falls back to id (`src/rooms/contracts/rpc-runs.ts:81-90`, `src/rooms/runs/server/rpc/runs.ts:246-263`). |
| Run page | Project id, optional section, nonnegative offset, limit 1–200, optional `pinOpen`. | Section, database and view-building failures reject; the page response includes runs and total (`src/rooms/contracts/rpc-runs.ts:91-94`, `src/rooms/settings/server/rpc/settings.ts:262-266`). |
| Stage results | Run id, then run/task/stage ids for one result. | Missing stage summary is an empty list; a result lookup reports missing row separately from an empty result body (`src/rooms/contracts/rpc-runs.ts:95-102`, `src/rooms/storage/database.ts:804-826`). |

## Business rules

`task_card` is nullable when its run or task is absent; stage summaries omit result JSON and the result endpoint loads a single body (`src/rooms/contracts/rpc-runs.ts:44-57`, `:95-102`, `src/rooms/storage/database.ts:804-826`). `list_runs` uses newest-first ordering and may include open runs beyond the requested page when `pinOpen` is true (`src/rooms/storage/database.ts:1557-1561`). Check-log paths are restricted before they are combined with a writer workspace path (`src/rooms/runs/server/rpc/runs.ts:236-240`).

## Public API or commands

Procedures covered here are `task_board`, `task_card`, `get_run_card`, `native_thread`, `list_runs`, `list_run_stages`, and `get_stage_result` (`src/rooms/contracts/rpc-runs.ts:30-102`). Other procedures later in `rpcRuns` belong to the screen and helper-access views and remain documented by their owning RPC page.

## Gotchas

- `native_thread` does not catch errors while parsing a stored selection; only agent id derivation and effective profile compilation have local fallback handling (`src/rooms/runs/server/rpc/runs.ts:246-263`).
- `list_runs` section selection reads the section chain before querying runs; those lookup errors are not converted into an empty page (`src/rooms/settings/server/rpc/settings.ts:262-266`).
- `task_board` caches thread titles only for presentation; a failed SDK read yields null title and does not drop the board item (`src/rooms/runs/server/rpc/runs.ts:173-181`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
