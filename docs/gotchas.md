---
title: Cross-cutting gotchas
type: gotchas
created: 2026-10-10
updated: 2026-11-14
status: active
confidence: medium
tags: [gotchas, runtime, failure-modes]
sources:
  - src/rooms/writer/models/live-folder.ts
  - src/rooms/writer/server/services/dispatch.ts
  - src/rooms/writer/server/services/start.ts
  - src/rooms/writer/server/services/start-wait-overlap.ts
  - src/rooms/writer/server/services/start-task-state.ts
  - src/rooms/writer/server/services/start-admission.ts
  - src/rooms/writer/server/repositories/start-failure-records.ts
  - src/rooms/writer/server/services/start-fallback-chain.ts
  - src/rooms/writer/server/services/start-writer-task.ts
  - src/rooms/stability/server/services/reconcile.ts
  - src/rooms/runs/models/checks-in-flight.ts
  - src/rooms/worktree/worktree-dependencies.ts
  - src/rooms/worktree/deps-install.ts
  - src/rooms/writer/server/services/reopen-attempt.ts
  - src/rooms/writer/server/services/verify.ts
  - src/rooms/writer/server/services/finish.ts
  - src/rooms/writer/server/services/finish-merge.ts
  - src/rooms/writer/server/services/watch-writer.ts
  - src/rooms/stability/server/services/stability.ts
  - src/rooms/relay/server/services/relay.ts
  - src/rooms/relay/server/handlers/relay-deadlines.ts
  - src/rooms/verification/sandbox.ts
  - tests/server/resumed-attempt-redo.test.ts
  - tests/server/resumed-running-writer.test.ts
  - tests/writer-validate.test.ts
  - packages/kit/src/spawn-async.ts
  - packages/kit/src/output-capture.ts
  - src/rooms/native-agent/server/services/helper-bb-shim.ts
  - src/rooms/native-agent/server/services/native-dispatch.ts
  - src/rooms/stability/server/services/deploy-drain.ts
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
  - src/rooms/platform/server/services/launch-tuning.ts
  - src/rooms/platform/server/services/pm-spawn.ts
  - src/rooms/writer/server/services/skill-materialize.ts
  - tests/dispatch-ownership-reload.test.ts
---

# Cross-cutting gotchas

TL;DR: Workspace mode, host capabilities, event delivery, and isolated test setup change how writer tasks behave; callers must use the recorded mode and explicit failure state.

## Writer workspace modes

- A new public dispatch into a folder without Git does not silently use live-folder mode: the guard requires the owner's project/section choice, the authenticated GitHub account on that host, and a successful private-Git bootstrap. A declined choice, missing provider/auth, unknown probe, or stopped bootstrap is an explicit refusal. An attempt already admitted with `workspace_decision.reason=live_folder` uses the legacy live-folder snapshots and rollback backups; it has no worktree, commit, or merge. In the same project and checkout, a queued task waits behind an admitted task when the workspace is a live folder, the task areas match, or owned paths overlap (`src/rooms/writer/server/services/start-wait-overlap.ts`, `src/rooms/writer/server/services/start-admission.ts`, `src/rooms/writer/server/services/start-writer-task.ts`). Snapshots are capped by path count, and files above 20 MiB use size/mtime fingerprints (`src/rooms/writer/models/live-folder.ts:14-18`).
- Live-folder backups retain seven days of data and refuse owned-file sets above 2 GiB (`src/rooms/writer/models/live-folder.ts:16-18`). Snapshot output has its own 6 MiB ceiling because host calls cap `runCommand` output (`src/rooms/writer/models/live-folder.ts:20-28`).
- Task ownership filters snapshot paths through `owns_paths` and `never_touch`; the backup listing walks every file and symlink under the task's owned roots, including clean files and nested repositories.
- A snapshot cap or malformed response returns a concrete refusal reason; dispatch must not treat it as an empty snapshot.

## Dispatch and retries

A repeat dispatch of the same task id, contract, and plan within 30 minutes returns the existing task when its latest attempt is neither blocked nor canceled; before an attempt exists, it returns the existing task only if no stage receipt is blocked or failed (`src/rooms/writer/server/services/dispatch.ts`). A task from the same task-id family is rejected while a sibling attempt is open or parked, except `mainfix` tasks.

A task dispatched in a run with `run_gate=pre-merge` is created with its canonical plan, receives a blocked `run-gate` receipt and skipped helper/writer stages, and blocks the run before creating an attempt.

If a reload interrupts dispatch after helper stages or ownership capture, `resumeDispatch` restarts the pipeline for the same attempt when the workflow engine has a pipeline record; the immutable base is retained even if HEAD moved, helper stages restart except a passed PM-read, and baseline can still block before any writer starts (`src/rooms/writer/server/services/dispatch.ts`, `tests/dispatch-ownership-reload.test.ts`). A writer reopened after a PM answer or contract fix is sent directly back into its existing thread and skips admission waits it already passed on the first start (`src/rooms/writer/server/services/reopen-attempt.ts`, `src/rooms/writer/server/services/start-writer-task.ts`, `src/rooms/writer/server/services/start-task-state.ts`).

After a task passes writer admission, it holds its checkout against relevant queued tasks through its redo and fallback attempts (`src/rooms/writer/server/services/start-wait-overlap.ts`). Dependency ordering can exempt a task from blocking or being blocked to avoid deadlock.

On reload recovery, a writer thread found idle or errored while its attempt is still running is restarted through `startWriterTask` with `turnSent: true`; that re-enters the current writer turn in the same thread (`src/rooms/stability/server/services/reconcile.ts`).

Writer-owned validation failures are included in the next writer's brief on an eligible retry or fallback (`src/rooms/writer/server/repositories/start-failure-records.ts`, `src/rooms/writer/server/services/start-task-state.ts`). A merge and moved-main replay register as checks in flight (`src/rooms/writer/server/services/finish-merge.ts`, `src/rooms/runs/models/checks-in-flight.ts`).

When a continued writer waits for its queued follow-up turn under a token or wall budget, the pending wait's later rejection is consumed so it does not become an unhandled rejection in the BB server (`src/rooms/writer/server/services/watch-writer.ts`).

## Event and polling behavior

BB thread lifecycle events wake watchers, but the thread's final status comes from a fresh read and a fallback poll covers missed events (`packages/thread-observe/src/signals.ts:3-10`). A top-level `error` status includes a detected BB failure cause after `thread_status_error:` (`packages/thread-observe/src/completion.ts`). `LANE_PILOT_THREAD_SIGNALS=0` disables signal subscriptions (`packages/thread-observe/src/signals.ts`, `src/rooms/core/server/lifecycle-events.ts`). Poll pauses can be scaled for test environments by `LANE_PILOT_POLL_SCALE` (`packages/kit/src/pace.ts`).

Lifecycle-event registration is best-effort (`src/rooms/core/server/lifecycle-events.ts`). Archived or deleted PM threads close abandoned runs only when the run has no open attempt.

## Stability and local provider setup

Stability breakers are persisted across plugin reloads and restored only for the same Lane Pilot version (`src/rooms/stability/server/services/stability.ts`). A version change discards a prior open breaker because the fault may have shipped fixed.

OpenCode v2 runs every session in one shared service per host, so a thread's process environment cannot change its config. Lane Pilot's OpenCode writers get `agent=lane-pilot` and a git-excluded `.opencode/opencode.jsonc` that turns OpenCode's own compaction off (`src/rooms/platform/server/services/pm-spawn.ts`, `src/rooms/writer/server/services/skill-materialize.ts`).

Read-only helper spawn tuning (`withLaunchTuning`) attaches `experimental_vkLaunchTuning` for roles that answer without shells (`src/rooms/platform/server/services/launch-tuning.ts`, `src/rooms/platform/server/services/pm-spawn.ts`); `LANE_PILOT_LAUNCH_TUNING=off` disables tuning on the hub.

Codex, OpenCode (`opencode2`) and Cursor helper providers get environment entries (`LANE_PILOT_ROLE` and guarded `PATH`) when host preparation succeeds (`src/rooms/native-agent/server/services/helper-bb-shim.ts`). A Codex writer receives a task-specific `CODEX_HOME` only when strict-user mode is enabled.

Reload drain covers checkout-writing host methods and `runSandboxedCommand` acceptance checks (`src/rooms/stability/server/services/deploy-drain.ts`).

If a fallback chain ends without acceptance, its last retry-eligible attempt transitions to `blocked` (`src/rooms/writer/server/services/start-fallback-chain.ts`).

Relay groups task outcomes for a PM (`src/rooms/relay/server/services/relay.ts`, `src/rooms/relay/server/handlers/relay-deadlines.ts`). A canceled-only group is recorded as reported without sending a message; within the 24-hour notice window a due group waits when the PM thread is busy or sending fails.

An owner-dated reminder is exempt from the two-hour cap and the repeated time-only reminder chain limit.

Sandboxed checks use `spawnAsync` with `keepEnds`, linking installed user tool homes and Playwright browser binaries (`src/rooms/verification/sandbox.ts`).

Worktree preparation installs dependencies from the root lockfile when missing and mirrors mutable npm state (`src/rooms/worktree/deps-install.ts`, `src/rooms/worktree/worktree-dependencies.ts`).

## Test isolation

Vitest assigns one scratch directory per run to `TMPDIR`, `TEMP`, and `TMP` (`tests/global-setup.ts`, `tests/tmpdir-isolation.test.ts`). Node files that mock modules and selected UI files run in isolated Vitest projects (`vitest.config.ts`, `tests/ui-matrix/helpers.tsx`).

`scripts/test-full.sh` keys success receipts by the committed tree hash and Node version. The record-and-guard helper records raw hook identity and forwards a normalized Lane Pilot PM marker (`scripts/record_and_guard.py`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Orchestration and execution data](data-model/orchestration.md)
- [Development](guide/development.md)
- [Lane Pilot overview](overview.md)
- [Testing and verification](testing.md)
