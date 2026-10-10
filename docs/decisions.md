---
title: Architectural decisions
type: decisions
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [decisions, adr]
sources:
  - .agents/decisions/2026-10-06-worktree-only-writers.md
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/writer/live-folder.ts
  - docs/decisions/2026-10-08-lane-pilot-data-db-access.md
  - server.ts
---

# Architectural decisions

TL;DR: This page records implementation-facing ADRs and links to the existing detailed decision records.

## ADR 1: Isolate writer workspaces

**Context.** The decision draft `.agents/decisions/2026-10-06-worktree-only-writers.md` reports repeated ownership, dirt, and empty-output failures in shared in-place execution. The current writer start path prepares an attempt workspace, while finish evaluates and completes the attempt (`src/rooms/writer/server/start.ts:1-80`, `src/rooms/writer/server/finish.ts:1-80`). A newer live-folder branch supports projects that are not Git repositories by substituting snapshots and rollback copies (`src/rooms/writer/live-folder.ts:5-22`).

**Decision.** Run writers in isolated attempt workspaces for Git-backed projects. For folders without Git, use the explicit live-folder mode with ownership-filtered snapshots and per-attempt backup/rollback; do not represent this branch as a Git worktree or merge (`src/rooms/writer/live-folder.ts:5-15`, `:142-145`).

**Status.** Accepted; the no-Git path narrows the original draft's universal worktree wording.

**Consequences.** Git-backed acceptance compares an attempt's recorded workspace state; a no-Git attempt instead depends on snapshot and backup limits (`src/rooms/writer/live-folder.ts:16-32`, `src/rooms/writer/server/finish.ts:1-80`). Worktree setup and cleanup remain separate from live-folder rollback (`server.ts:111-125`).

## Existing decisions

- [Lane Pilot database access](decisions/2026-10-08-lane-pilot-data-db-access.md)
- [Council economy design record](decisions/2026-10-09-council-как-построить-экономику-живого-мира-lane-pilot-п.md)
