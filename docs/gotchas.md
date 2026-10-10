---
title: Cross-cutting gotchas
type: gotchas
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [gotchas, runtime, failure-modes]
sources:
  - src/rooms/writer/live-folder.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/server/verify.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/stability/server/stability.ts
  - src/rooms/core/server/opencode-minimal.ts
  - src/rooms/core/server/lifecycle-events.ts
  - packages/thread-observe/src/signals.ts
  - packages/thread-observe/src/completion.ts
  - packages/kit/src/pace.ts
  - scripts/record_and_guard.py
  - scripts/test-full.sh
  - tests/global-setup.ts
  - tests/tmpdir-isolation.test.ts
  - tests/ui-matrix/helpers.tsx
  - vitest.config.ts
---

# Cross-cutting gotchas

TL;DR: Workspace mode, host capabilities, event delivery, and isolated test setup change how writer tasks behave; callers must use the recorded mode and explicit failure state.

## Writer workspace modes

- A folder without Git uses live-folder snapshots and rollback backups; it has no worktree, commit, or merge. Only one writer may edit that live folder at a time, and other work for it waits (`src/rooms/writer/server/start.ts:142-145`, `:369-370`). Snapshots are capped at 50,000 paths, and files above 20 MiB use size/mtime fingerprints (`src/rooms/writer/live-folder.ts:5-22`, `:89-111`).
- Live-folder backups retain seven days of data and refuse owned-file sets above 2 GiB (`src/rooms/writer/live-folder.ts:20-22`). Snapshot output has its own 6 MiB ceiling because host calls cap `runCommand` output (`src/rooms/writer/live-folder.ts:23-32`).
- Task ownership still filters paths through `owns_paths` and `never_touch`; a rollback backup only covers the task-owned files (`src/rooms/writer/live-folder.ts:142-145`).
- A snapshot cap or malformed response returns a concrete refusal reason; dispatch must not treat it as an empty snapshot (`src/rooms/writer/live-folder.ts:119-139`).

## Dispatch and retries

A repeat dispatch of the same task id, contract, and plan within 30 minutes returns the existing task when the latest attempt is not blocked or canceled; it creates no second task (`src/rooms/writer/server/dispatch.ts:79-93`, `:139-141`). A task from the same task-id family is rejected while a sibling attempt is open or parked, except `mainfix` tasks (`src/rooms/writer/server/dispatch.ts:95-103`, `:142-148`).

A run with a pre-merge gate records a blocked run-gate receipt and skipped downstream stage receipts before writer dispatch (`src/rooms/writer/server/dispatch.ts:155-164`).

## Event and polling behavior

BB thread lifecycle events wake watchers, but the thread's final status comes from a fresh read and a 20-second fallback poll covers missed events (`packages/thread-observe/src/signals.ts:3-10`). `LANE_PILOT_THREAD_SIGNALS=0` disables signal subscriptions; it also leaves polling as the watcher path (`packages/thread-observe/src/signals.ts:84-99`, `src/rooms/core/server/lifecycle-events.ts:22-37`). Poll pauses can be scaled for test environments by `LANE_PILOT_POLL_SCALE` (`packages/kit/src/pace.ts:1-8`).

Lifecycle-event registration is best-effort: BB versions that do not recognize an event produce a log entry while scheduled sweeps remain the recovery mechanism (`src/rooms/core/server/lifecycle-events.ts:26-37`). Archived or deleted PM threads close abandoned runs only when the run has no open attempt (`src/rooms/core/server/lifecycle-events.ts:39-48`).

## Stability and local provider setup

Stability breakers are persisted across plugin reloads and restored only for the same Lane Pilot version (`src/rooms/stability/server/stability.ts:62-82`). A version change discards a prior open breaker because the fault may have shipped fixed (`src/rooms/stability/server/stability.ts:67-80`).

The OpenCode minimal-config environment hook has a four-second total budget. It uses prewarmed state; when preparation is still pending or fails, the helper is refused rather than started with the full host config (`src/rooms/core/server/opencode-minimal.ts:9-20`, `:27-37`).

## Test isolation

Vitest assigns one scratch directory per run to `TMPDIR`, `TEMP`, and `TMP`; teardown removes it, and a later run sweeps directories left by dead processes (`tests/global-setup.ts:9-35`, `tests/tmpdir-isolation.test.ts:7-17`). Node files that mock modules and selected UI files run in isolated Vitest projects; the shared UI matrix gets a 60-second test timeout and empties the DOM before and after each test (`vitest.config.ts:4-32`, `tests/ui-matrix/helpers.tsx:6-26`).

`scripts/test-full.sh` keys success receipts by the committed tree hash and Node version. A dirty tracked tree still runs Vitest but does not write a receipt; an existing receipt skips the full run for the same key (`scripts/test-full.sh:2-18`). The record-and-guard helper records raw hook identity and forwards a normalized Lane Pilot PM marker to the guard process (`scripts/record_and_guard.py:19-49`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot overview](overview.md)
