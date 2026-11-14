---
title: Architectural decisions
type: decisions
created: 2026-10-10
updated: 2026-10-29
status: active
confidence: medium
tags: [decisions, adr]
sources:
  - .agents/decisions/2026-10-06-worktree-only-writers.md
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/writer/live-folder.ts
  - server.ts
  - docs/decisions/2026-10-08-lane-pilot-data-db-access.md
---

# Architectural decisions

TL;DR: This page records implementation-facing ADRs and links to the existing detailed decision records.

## ADR 1: Isolate writer workspaces

**Context.** The decision draft `.agents/decisions/2026-10-06-worktree-only-writers.md` reports repeated ownership, dirt, and empty-output failures in shared in-place execution. Writer start binds a fresh attempt to the run workspace and checks its workspace mode before admission; finish evaluates and completes the attempt (`src/rooms/writer/server/start.ts:160-169`, `:354-389`, `src/rooms/writer/server/finish.ts:1-82`). A live-folder branch supports projects that are not Git repositories by substituting snapshots and rollback copies (`src/rooms/writer/live-folder.ts:5-22`).

**Decision.** Run writers in isolated attempt workspaces for Git-backed projects. For folders without Git, use the explicit live-folder mode with ownership-filtered snapshots and per-attempt backup/rollback; do not represent this branch as a Git worktree or merge (`src/rooms/writer/live-folder.ts:5-15`, `:142-145`).

**Status.** Accepted; the no-Git path narrows the original draft's universal worktree wording.

**Consequences.** Git-backed acceptance validates the writer result and merges the bound attempt worktree; a no-Git attempt instead depends on snapshot and backup limits (`src/rooms/writer/server/finish.ts:284-296`, `:741-767`, `src/rooms/writer/live-folder.ts:16-32`). The scheduled `attempt-worktree-sweep` releases finished attempt environments and expired sticky lane worktrees, while the writer loop invokes live-folder rollback after failed attempts (`server.ts:189-198`, `src/rooms/writer/server/start.ts:756-759`).

## ADR 2: One home per task, under the task's base checkout

**Context.** One task's files were scattered over `.agents/plans/items/<id>/`, `.agents/runs/<run>/artifacts/<id>/`, the attempt worktree and the DB. Readers found them by listing folders or picking the newest file, and a project with a separate planning home could split a task between two roots (audit `handoff-map.md` §2, §4.2).

**Decision.** Every file of a task goes into `.agents/tasks/<task-id>/` under the task's base checkout (`taskBasePath`, the same rule the old `items/` folder used). `.agents/tasks/` is not a planning path, so `isPlanningPath`/`planningText` never move it to the planning home, and a task's first root is kept (`openTaskHome` is idempotent). The DB tables `lane_pilot_task_home`/`lane_pilot_task_file`/`lane_pilot_task_file_read` are the source of truth; `manifest.json` is their rendering ([task-folder.md](task-folder.md)).

**Status.** Accepted for the main task path (step 1); the other graphs follow in step 2.

**Consequences.** Tasks dispatched before the switch finish on the old layout; the resolver reads their files by exact old name and counts each read.

## Existing decisions

- [Lane Pilot database access](decisions/2026-10-08-lane-pilot-data-db-access.md)
- [Council economy design record](decisions/2026-10-09-council-как-построить-экономику-живого-мира-lane-pilot-п.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Development](guide/development.md)
