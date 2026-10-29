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

## Existing decisions

- [Lane Pilot database access](decisions/2026-10-08-lane-pilot-data-db-access.md)
- [Council economy design record](decisions/2026-10-09-council-как-построить-экономику-живого-мира-lane-pilot-п.md)
