---
title: Tasks board and work graph
type: component
created: 2026-10-13
updated: 2026-10-29
status: active
confidence: medium
tags: [tasks, runs, ui, task-graph]
sources:
  - src/rooms/runs/server/task-board.ts
  - src/rooms/runs/server/rpc/runs.ts
  - src/rooms/runs/ui/task-board.tsx
  - src/rooms/runs/server/task-graph.ts
  - src/rooms/native-agent/ui/task-graph-view.tsx
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/contracts/rpc-native.ts
  - src/rooms/native-agent/ui/helper-threads.tsx
  - src/rooms/ui-shell/ui/page.tsx
  - src/rooms/ui-shell/ui/project-nav.tsx
---

# Tasks board and work graph

TL;DR: The Tasks screen presents Lane Pilot tasks and top-level workflow runs as a filterable board or grouped list, with detail cards and dependency graphs for active work.

## Purpose

The app's Tasks navigation scope renders `TaskBoard`; it reads the board and task card through the runs RPC methods (`src/rooms/ui-shell/ui/page.tsx:45-56`, `src/rooms/ui-shell/ui/project-nav.tsx:9-16`, `src/rooms/runs/ui/task-board.tsx:121-150`). The helper-thread panel can show the open run's task dependency graph (`src/rooms/native-agent/ui/helper-threads.tsx:70-84`, `src/rooms/contracts/rpc-native.ts:127-144`).

## How it works

1. The `tasks` navigation scope mounts `TaskBoard` with visible projects and the selected project (`src/rooms/ui-shell/ui/page.tsx:45-56`).
2. The screen calls `task_board` immediately and every eight seconds, sending the selected project when scoped and a completion window; a failed refresh marks the board offline — a first failure replaces the loading line with «Could not load tasks», and a failure while items are shown says they are the last known states (`src/rooms/runs/ui/task-board.tsx:26`, `:134-146`, `:215`).
3. The server selects each task's latest attempt, includes live work and recent terminal work, removes superseded task-family attempts, derives column/phase from attempt and stage receipts, and adds top-level workflow runs (`src/rooms/runs/server/task-board.ts:63-78`, `:81-144`).
4. The UI filters by task/workflow kind, project, search text, and service-project visibility, then renders fixed columns or a list grouped by goal, chat, area, project, or no group (`src/rooms/runs/ui/task-board.tsx:121-148`, `:169-209`).
5. Opening an item calls `task_card`. The server reads its contract, plan, ordered stages, attempts and worker threads; thread roots include writer attempts and helper stages, with each root's child sub-agent threads (`src/rooms/runs/ui/task-board.tsx:328-329`, `src/rooms/runs/server/task-board.ts:160-209`, `src/rooms/runs/server/rpc/runs.ts:182-201`). The task page also loads the acceptance card with `task_acceptance_card`: contract, plan against fact, stage receipts with their proof kind, gate events, what did not run, risk, base commit and cost (see [Plan against fact and the acceptance card](plan-fact.md)).
6. The helper panel calls `list_helper_threads`; for an open run, the server adds `buildTaskGraph` output, which the UI lays out as task nodes joined by wait edges (`src/rooms/native-agent/ui/helper-threads.tsx:70-84`, `src/rooms/runs/server/rpc/runs.ts:46-50`, `src/rooms/runs/server/task-graph.ts:21-58`, `src/rooms/native-agent/ui/task-graph-view.tsx:16-36`).

### Modes and variants

| Mode or input | What differs | Evidence |
|---|---|---|
| Board / list | Board uses fixed queued, running, checking, blocked and done columns. List groups by goal, chat, area, project, or no group. | `src/rooms/runs/ui/task-board.tsx:21-23`, `:126-128`, `:160-195` |
| Project scope | A project selection limits results; all-project view hides service-project work until the drills switch is enabled. | `src/rooms/runs/ui/task-board.tsx:125-130`, `:145-148`, `src/rooms/runs/server/task-board.ts:63-75` |
| Completion window | The UI sends 24 or 168 hours; live attempts remain included regardless of this window. | `src/rooms/runs/ui/task-board.tsx:128-129`, `:197-202`, `src/rooms/runs/server/task-board.ts:67-75` |
| Item kind | The board combines task attempts and top-level workflow runs; the kind filter can show either or both. | `src/rooms/runs/ui/task-board.tsx:125-127`, `src/rooms/runs/server/task-board.ts:81-144` |
| Helper graph | Nodes are running, waiting, queued, or blocked. Edges identify dependency, file, folder, or question waits. Accepted and canceled tasks are omitted; blocked tasks appear when a shown task waits for them. | `src/rooms/runs/server/task-graph.ts:4-7`, `:21-58`, `src/rooms/contracts/rpc-native.ts:139-143` |

### Failures

- A failed board refresh shows an offline notice: the loading line becomes «Could not load tasks. Retrying…», and when earlier items are on screen the notice says they are the last known states (`src/rooms/runs/ui/task-board.tsx:134-146`, `:215`).
- A missing task or run makes `readTaskCard` return `null`; the UI also displays its gone state when the card call rejects (`src/rooms/runs/server/task-board.ts:161-179`, `src/rooms/runs/ui/task-board.tsx:328-329`).
- Thread metadata read failures produce a thread entry with null title/status; child-list failures produce an empty child list (`src/rooms/runs/server/rpc/runs.ts:189-198`).
- Database read failures are not converted to an empty board or card by the RPC handlers; a board refresh failure leaves prior results visible under the offline notice, while a rejected card request enters the UI's gone state (`src/rooms/runs/server/rpc/runs.ts:174-184`, `src/rooms/runs/ui/task-board.tsx:134-146`, `:215`, `:328-329`).
- The helper graph is omitted when there is no open run, and no graph edges are created for self-dependencies or blockers that are not shown and are not blocked tasks (`src/rooms/runs/server/rpc/runs.ts:165-169`, `src/rooms/runs/server/task-graph.ts:39-42`).

## Business rules

- The board represents only the latest attempt for a task and omits attempts superseded by a later task-family member (`src/rooms/runs/server/task-board.ts:67-75`).
- An open queued attempt waiting on planning or a named blocker appears in the queued column; a live attempt with active checks or a passed writer stage appears in checking (`src/rooms/runs/server/task-board.ts:94-108`).
- A latest failed attempt is shown as retrying for the retry grace period, then as stuck; a task whose run is closed is shown as closed in the blocked column (`src/rooms/runs/server/task-board.ts:27-33`, `:108-113`).
- A workflow is included only when it is a top-level run and is not linked to a task; its status maps to the same five columns (`src/rooms/runs/server/task-board.ts:125-144`).

## Public API or commands

| RPC method | Input and output |
|---|---|
| `task_board` | Optional project id and integer `doneHours` from 1 to 720 (default 24); returns board items with project and PM-thread titles (`src/rooms/contracts/rpc-runs.ts:30-43`, `src/rooms/runs/server/rpc/runs.ts:171-180`). |
| `task_card` | Run id and nullable task id; returns a task or workflow card with stages, attempts, contract, plan and threads, or null (`src/rooms/contracts/rpc-runs.ts:45-52`, `src/rooms/runs/server/rpc/runs.ts:182-202`). |
| `list_helper_threads` | Parent thread id; returns helper threads, queued task ids, and optional graph for the open run (`src/rooms/contracts/rpc-native.ts:127-144`). |

## Gotchas

The helper graph derives waits from task contracts and the writer-stage reason strings; it is a view of the current run state, not a persisted graph (`src/rooms/runs/server/task-graph.ts:21-58`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot architecture](architecture.md)
- [Lane Pilot overview](overview.md)
- [RPC and host-call contracts](rpc-callers.md)
