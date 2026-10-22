---
title: Cross-cutting gotchas
type: gotchas
created: 2026-10-10
updated: 2026-10-17
status: active
confidence: medium
tags: [gotchas, runtime, failure-modes]
sources:
  - src/rooms/writer/live-folder.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/server/reopen-attempt.ts
  - src/rooms/writer/server/verify.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/stability/server/stability.ts
  - src/rooms/self-repair/server/self-repair.ts
  - src/rooms/relay/server/relay.ts
  - src/rooms/verification/sandbox.ts
  - packages/kit/src/spawn-async.ts
  - packages/kit/src/output-capture.ts
  - src/rooms/native-agent/server/helper-bb-shim.ts
  - src/rooms/stability/server/deploy-drain.ts
  - src/rooms/core/server/lifecycle-events.ts
  - packages/thread-observe/src/signals.ts
  - packages/thread-observe/src/completion.ts
  - src/rooms/writer/server/start.ts
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

A repeat dispatch of the same task id, contract, and plan within 30 minutes returns the existing task when its latest attempt is neither blocked nor canceled; before an attempt exists, it returns the existing task only if no stage receipt is blocked or failed (`src/rooms/writer/server/dispatch.ts:98-111`, `:184-186`). A task from the same task-id family is rejected while a sibling attempt is open or parked, except `mainfix` tasks (`src/rooms/writer/server/dispatch.ts:114-122`, `:187-192`).

A run with a pre-merge gate records a blocked run-gate receipt, records the PM-read, plan-critique, specialist-review, writer-agent, verification, and acceptance-receipt stages as skipped, sets the run to blocked, and returns before creating an attempt (`src/rooms/writer/server/dispatch.ts:201-212`).

If a reload interrupts dispatch before the ownership base is taken, recovery restarts its stored stages for the same attempt when the workflow engine has a pipeline record; helper stages restart except a passed PM-read. It blocks with a reason when the engine is off, no pipeline record exists, the base was taken, or the resume limit was exceeded (`src/rooms/writer/server/dispatch.ts:608-645`). A writer reopened after a PM answer or contract fix is sent directly back into its existing thread and skips admission waits it already passed on the first start (`src/rooms/writer/server/reopen-attempt.ts:77-111`, `src/rooms/writer/server/start.ts:417-423`).

After a task passes writer admission, it holds its ownership paths through its redo and fallback attempts. A queued task in the same project and checkout waits when its `owns_paths` overlap or its area matches; the hold is in memory and is released when the writer loop finishes (`src/rooms/writer/server/start.ts:63-70`, `:254-305`, `:422-423`, `:954-958`).

## Event and polling behavior

BB thread lifecycle events wake watchers, but the thread's final status comes from a fresh read and a 20-second fallback poll covers missed events (`packages/thread-observe/src/signals.ts:3-10`). For a thread whose status is `error`, the completion detail appends a detected thread failure cause to `thread_status_error:`; without a detected cause it remains `thread_status_error` (`packages/thread-observe/src/completion.ts:86-90`, `:150-178`). `LANE_PILOT_THREAD_SIGNALS=0` disables signal subscriptions; it also leaves polling as the watcher path (`packages/thread-observe/src/signals.ts:84-99`, `src/rooms/core/server/lifecycle-events.ts:22-37`). Poll pauses can be scaled for test environments by `LANE_PILOT_POLL_SCALE` (`packages/kit/src/pace.ts:1-8`).

Lifecycle-event registration is best-effort: BB versions that do not recognize an event produce a log entry while scheduled sweeps remain the recovery mechanism (`src/rooms/core/server/lifecycle-events.ts:26-37`). Archived or deleted PM threads close abandoned runs only when the run has no open attempt (`src/rooms/core/server/lifecycle-events.ts:39-48`).

## Stability and local provider setup

Stability breakers are persisted across plugin reloads and restored only for the same Lane Pilot version (`src/rooms/stability/server/stability.ts:62-82`). A version change discards a prior open breaker because the fault may have shipped fixed (`src/rooms/stability/server/stability.ts:67-80`).

OpenCode v2 runs every session in one shared service per host, so a thread's process environment cannot change its config. Lane Pilot's OpenCode writers get `agent=lane-pilot` (the lane hooks act only under a `lane-` agent) and a git-excluded `.opencode/opencode.jsonc` that turns OpenCode's own compaction off; a project's own config is kept (`src/rooms/core/server/pm-spawn.ts:88-124`, `src/rooms/writer/server/skill-materialize.ts:13-21`).

Codex, OpenCode (`opencode2`, which sets them as the session's shell environment) and Cursor helpers use the BB shim contributor. Only Lane Pilot threads with role metadata receive `LANE_PILOT_ROLE` and a host-prepared wrapper `PATH`; PM and owner threads are left alone (`src/rooms/native-agent/server/helper-bb-shim.ts:5-18`, `:63-82`). A host that reports an unknown `prepareBbShim` call is allowed to start without wrappers, but other preparation failures reject the helper start. If thread metadata cannot be read, the helper starts without wrappers (`src/rooms/native-agent/server/helper-bb-shim.ts:45-76`).

Reload drain covers checkout-writing host methods and `runSandboxedCommand` acceptance checks. Other host calls bypass the drain; an active drain blocks new covered calls while existing calls finish, and an expired drain stops blocking after 20 minutes (`src/rooms/stability/server/deploy-drain.ts:1-25`). A lifecycle drain can reach its deadline with calls still in flight and records `clean: false` with their method names and ages (`src/rooms/stability/server/deploy-drain.ts:65-79`).

Before saving a non-dry-run tick, self-repair drops the oldest eligible signatures while its serialized state exceeds 200 KiB; it does not prune signatures with a worktree or pending spawn. Loading state truncates each stored sample reason to 1,000 characters (`src/rooms/self-repair/server/self-repair.ts:151`, `:364-368`); the repair prompt separately clips displayed reasons to 600 characters (`:302-304`).

The self-repair prompt tells its agent to contact a live PM only when that PM must act; for an idle PM it puts the next action in the repair report (`src/rooms/self-repair/server/self-repair.ts:307-319`). The queued-task watcher ignores a task while a dependency is queued, being spawned, running, or being canceled, and waits through the blocked-dependency redo window; a fallback chain that ends without acceptance transitions its last retry-eligible attempt to `blocked` (`src/rooms/self-repair/server/self-repair.ts:388-399`, `:437-449`, `src/rooms/writer/server/start.ts:837-844`).

Relay groups task outcomes for a PM. A canceled-only group is recorded as reported without sending a message; a mixed group includes canceled tasks as a count. Within the 24-hour notice window, a due group stays unreported when the PM thread is busy, the busy check fails, or sending fails, so a later sweep can retry it. Outcomes older than the window are marked reported without a notice. The background relay sweep runs every 30 seconds (`src/rooms/relay/server/relay.ts:88`, `:380-419`, `:614-620`).

Sandboxed checks use `spawnAsync` with `keepEnds`, so excess stdout/stderr is truncated to head-and-tail captures instead of terminating the check; stderr is capped separately after process completion (`src/rooms/verification/sandbox.ts:20-30`, `:210-217`, `:222-242`). `spawnAsync` without `keepEnds` still enforces its 1 MiB per-stream `maxBuffer` default (`packages/kit/src/spawn-async.ts:17-21`, `:40-45`).

## Test isolation

Vitest assigns one scratch directory per run to `TMPDIR`, `TEMP`, and `TMP`; teardown removes it, and a later run sweeps directories left by dead processes (`tests/global-setup.ts:9-35`, `tests/tmpdir-isolation.test.ts:7-17`). Node files that mock modules and selected UI files run in isolated Vitest projects; the shared UI matrix gets a 60-second test timeout and empties the DOM before and after each test (`vitest.config.ts:4-32`, `tests/ui-matrix/helpers.tsx:6-26`).

`scripts/test-full.sh` keys success receipts by the committed tree hash and Node version. A dirty tracked tree still runs Vitest but does not write a receipt; an existing receipt skips the full run for the same key (`scripts/test-full.sh:2-18`). The record-and-guard helper records raw hook identity and forwards a normalized Lane Pilot PM marker to the guard process (`scripts/record_and_guard.py:19-49`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Orchestration and execution data](data-model/orchestration.md)
- [Lane Pilot overview](overview.md)
