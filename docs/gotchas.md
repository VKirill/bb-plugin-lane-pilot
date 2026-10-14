---
title: Cross-cutting gotchas
type: gotchas
created: 2026-10-10
updated: 2026-10-14
status: active
confidence: medium
tags: [gotchas, runtime, failure-modes]
sources:
  - src/rooms/writer/live-folder.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/server/verify.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/stability/server/stability.ts
  - src/rooms/self-repair/server/self-repair.ts
  - src/rooms/core/server/opencode-minimal.ts
  - src/rooms/native-agent/server/helper-bb-shim.ts
  - src/rooms/stability/server/deploy-drain.ts
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
- Task ownership filters snapshot paths through `owns_paths` and `never_touch`; the backup listing walks every file and symlink under the task's owned roots, including clean files and nested repositories (`src/rooms/writer/live-folder.ts:197-212`, `:215-253`).
- A snapshot cap or malformed response returns a concrete refusal reason; dispatch must not treat it as an empty snapshot (`src/rooms/writer/live-folder.ts:119-139`).

## Dispatch and retries

A repeat dispatch of the same task id, contract, and plan within 30 minutes returns the existing task when the latest attempt is not blocked or canceled; it creates no second task (`src/rooms/writer/server/dispatch.ts:79-93`, `:139-141`). A task from the same task-id family is rejected while a sibling attempt is open or parked, except `mainfix` tasks (`src/rooms/writer/server/dispatch.ts:95-103`, `:142-148`).

A run with a pre-merge gate records a blocked run-gate receipt, records the PM-read, plan-critique, specialist-review, writer-agent, verification, and acceptance-receipt stages as skipped, sets the run to blocked, and returns before creating an attempt (`src/rooms/writer/server/dispatch.ts:184-193`).

## Event and polling behavior

BB thread lifecycle events wake watchers, but the thread's final status comes from a fresh read and a 20-second fallback poll covers missed events (`packages/thread-observe/src/signals.ts:3-10`). `LANE_PILOT_THREAD_SIGNALS=0` disables signal subscriptions; it also leaves polling as the watcher path (`packages/thread-observe/src/signals.ts:84-99`, `src/rooms/core/server/lifecycle-events.ts:22-37`). Poll pauses can be scaled for test environments by `LANE_PILOT_POLL_SCALE` (`packages/kit/src/pace.ts:1-8`).

Lifecycle-event registration is best-effort: BB versions that do not recognize an event produce a log entry while scheduled sweeps remain the recovery mechanism (`src/rooms/core/server/lifecycle-events.ts:26-37`). Archived or deleted PM threads close abandoned runs only when the run has no open attempt (`src/rooms/core/server/lifecycle-events.ts:39-48`).

## Stability and local provider setup

Stability breakers are persisted across plugin reloads and restored only for the same Lane Pilot version (`src/rooms/stability/server/stability.ts:62-82`). A version change discards a prior open breaker because the fault may have shipped fixed (`src/rooms/stability/server/stability.ts:67-80`).

The OpenCode minimal-config environment hook has a four-second total budget. It uses prewarmed state; when preparation is still pending or fails, the helper is refused rather than started with the full host config (`src/rooms/core/server/opencode-minimal.ts:9-20`, `:27-37`). The same contributor combines the minimal config and BB guard environment under that budget (`src/rooms/core/server/opencode-minimal.ts:176-188`).

Codex and Cursor helpers use the BB shim contributor; OpenCode uses it alongside its minimal-config contributor. Only Lane Pilot threads with role metadata receive `LANE_PILOT_ROLE` and a host-prepared wrapper `PATH`; PM and owner threads are left alone (`src/rooms/native-agent/server/helper-bb-shim.ts:5-15`, `:62-80`, `src/rooms/core/server/opencode-minimal.ts:176-182`). A host that reports an unknown `prepareBbShim` call is allowed to start without wrappers, but other preparation failures reject the helper start. If thread metadata cannot be read, the helper starts without wrappers (`src/rooms/native-agent/server/helper-bb-shim.ts:44-75`).

Reload drain covers checkout-writing host methods and `runSandboxedCommand` acceptance checks. Other host calls bypass the drain; an active drain blocks new covered calls while existing calls finish, and an expired drain stops blocking after 20 minutes (`src/rooms/stability/server/deploy-drain.ts:1-25`). A lifecycle drain can reach its deadline with calls still in flight and records `clean: false` with their method names and ages (`src/rooms/stability/server/deploy-drain.ts:65-79`).

Before saving a non-dry-run tick, self-repair drops the oldest eligible signatures while its serialized state exceeds 200 KiB; it does not prune signatures with a worktree or pending spawn. Loading state truncates each stored incident reason to 1,000 characters (`src/rooms/self-repair/server/self-repair.ts:127-141`, `:287-307`, `:675-680`).

## Test isolation

Vitest assigns one scratch directory per run to `TMPDIR`, `TEMP`, and `TMP`; teardown removes it, and a later run sweeps directories left by dead processes (`tests/global-setup.ts:9-35`, `tests/tmpdir-isolation.test.ts:7-17`). Node files that mock modules and selected UI files run in isolated Vitest projects; the shared UI matrix gets a 60-second test timeout and empties the DOM before and after each test (`vitest.config.ts:4-32`, `tests/ui-matrix/helpers.tsx:6-26`).

`scripts/test-full.sh` keys success receipts by the committed tree hash and Node version. A dirty tracked tree still runs Vitest but does not write a receipt; an existing receipt skips the full run for the same key (`scripts/test-full.sh:2-18`). The record-and-guard helper records raw hook identity and forwards a normalized Lane Pilot PM marker to the guard process (`scripts/record_and_guard.py:19-49`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot overview](overview.md)
