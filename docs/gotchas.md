---
title: Cross-cutting gotchas
type: gotchas
created: 2026-10-10
updated: 2026-10-29
status: active
confidence: medium
tags: [gotchas, runtime, failure-modes]
sources:
  - src/rooms/writer/live-folder.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/stability/server/reconcile.ts
  - src/rooms/runs/checks-in-flight.ts
  - src/rooms/verification/git-integrate.ts
  - src/rooms/writer/server/reopen-attempt.ts
  - src/rooms/writer/server/verify.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/stability/server/stability.ts
  - src/rooms/self-repair/server/self-repair.ts
  - src/rooms/relay/server/relay.ts
  - src/rooms/verification/sandbox.ts
  - tests/server/resumed-attempt-redo.test.ts
  - tests/server/resumed-running-writer.test.ts
  - tests/server/self-repair.test.ts
  - tests/verification/check-env-deps.test.ts
  - tests/writer-validate.test.ts
  - packages/kit/src/spawn-async.ts
  - packages/kit/src/output-capture.ts
  - src/rooms/native-agent/server/helper-bb-shim.ts
  - src/rooms/native-agent/native-dispatch.ts
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
  - src/rooms/core/server/pm-spawn.ts
  - src/rooms/writer/server/skill-materialize.ts
---

# Cross-cutting gotchas

TL;DR: Workspace mode, host capabilities, event delivery, and isolated test setup change how writer tasks behave; callers must use the recorded mode and explicit failure state.

## Writer workspace modes

- A folder without Git uses live-folder snapshots and rollback backups; it has no worktree, commit, or merge. In the same project and checkout, a queued task waits behind an admitted task when the workspace is a live folder, the task areas match, or owned paths overlap. Queued tasks still waiting on dependencies do not block others; dependent tasks are exempted from waiting on their prerequisite, and different checkouts wait only for overlapping paths (`src/rooms/writer/server/start.ts:361-381`). The admission hold is in memory and spans redo/fallback attempts (`src/rooms/writer/server/start.ts:89-96`, `:346-359`, `:550`, `:1108-1112`). Snapshots are capped at 50,000 paths, and files above 20 MiB use size/mtime fingerprints (`src/rooms/writer/live-folder.ts:5-22`, `:89-111`).
- Live-folder backups retain seven days of data and refuse owned-file sets above 2 GiB (`src/rooms/writer/live-folder.ts:20-22`). Snapshot output has its own 6 MiB ceiling because host calls cap `runCommand` output (`src/rooms/writer/live-folder.ts:23-32`).
- Task ownership filters snapshot paths through `owns_paths` and `never_touch`; the backup listing walks every file and symlink under the task's owned roots, including clean files and nested repositories (`src/rooms/writer/live-folder.ts:197-212`, `:215-253`).
- A snapshot cap or malformed response returns a concrete refusal reason; dispatch must not treat it as an empty snapshot (`src/rooms/writer/live-folder.ts:119-139`).

## Dispatch and retries

A repeat dispatch of the same task id, contract, and plan within 30 minutes returns the existing task when its latest attempt is neither blocked nor canceled; before an attempt exists, it returns the existing task only if no stage receipt is blocked or failed (`src/rooms/writer/server/dispatch.ts:98-111`, `:184-186`). A task from the same task-id family is rejected while a sibling attempt is open or parked, except `mainfix` tasks (`src/rooms/writer/server/dispatch.ts:114-122`, `:187-192`).

A task dispatched in a run with `run_gate=pre-merge` is created with its canonical plan, receives a blocked `run-gate` receipt and skipped PM-read, plan-critique, specialist-review, writer-agent, verification, and acceptance-receipt stages, and blocks the run. Dispatch returns this result before creating an attempt (`src/rooms/writer/server/dispatch.ts:226-243`).

If a reload interrupts dispatch before the ownership base is taken, recovery restarts its stored stages for the same attempt when the workflow engine has a pipeline record; helper stages restart except a passed PM-read. It blocks with a reason when the engine is off, no pipeline record exists, the base was taken, or the resume limit was exceeded (`src/rooms/writer/server/dispatch.ts:565-602`). A writer reopened after a PM answer or contract fix is sent directly back into its existing thread and skips admission waits it already passed on the first start (`src/rooms/writer/server/reopen-attempt.ts:77-111`, `src/rooms/writer/server/start.ts:417-423`).

After a task passes writer admission, it holds its checkout against relevant queued tasks through its redo and fallback attempts. In a Git checkout, the blocker predicate checks same area or overlapping `owns_paths`; in a live folder, any other task in the same checkout waits. Dependency ordering can exempt a task from blocking or being blocked to avoid deadlock (`src/rooms/writer/server/start.ts:361-381`). The admitted-task map is per core instance and released at the end of the writer loop (`src/rooms/writer/server/start.ts:89-96`, `:346-359`, `:550`, `:1108-1112`).

On reload recovery, a writer thread found idle or errored while its attempt is still running is restarted through `startWriterTask` with `turnSent: true`; that re-enters the current writer turn in the same thread with its saved workspace and prior failure context. A cancellation observed during recovery becomes canceled; a missing matching thread ends as a spawn failure, and an ambiguous scan blocks the attempt (`src/rooms/stability/server/reconcile.ts:82-109`, `:111-145`).

Writer-owned validation failures are included in the next writer's brief on an eligible retry or fallback, so the new attempt receives the rejected paths and reason. Provider failures do not become task-failure context; when loading prior failures, an accepted attempt ends the search (`src/rooms/writer/server/start.ts:57-85`, `:193-195`, `:679-685`). A resumed attempt whose worktree contains Lane Pilot's own receipt from a pass interrupted by reload continues through validation (`tests/writer-validate.test.ts:277-327`).

When a continued writer waits for its queued follow-up turn under a token or wall budget, the wait is checked every two seconds. If the budget stops the attempt first, the pending wait's later rejection is consumed so it does not become an unhandled rejection in the BB server (`src/rooms/writer/server/finish.ts:194-215`).

The self-repair repeat detector excludes a task's own red verification checks when they are classified as task failures; checks attributed to the orchestrator or environment still count (`src/rooms/self-repair/server/self-repair.ts:159-168`, `:561-578`). A merge and moved-main replay register as checks in flight, so the stuck-attempt watcher sees that work before it finishes (`src/rooms/writer/server/finish.ts:747-767`, `src/rooms/self-repair/server/self-repair.ts:470-473`, `src/rooms/runs/checks-in-flight.ts:11-37`).

## Event and polling behavior

BB thread lifecycle events wake watchers, but the thread's final status comes from a fresh read and a 20-second fallback poll covers missed events (`packages/thread-observe/src/signals.ts:3-10`). For a thread whose status is `error`, the completion detail appends a detected thread failure cause to `thread_status_error:`; without a detected cause it remains `thread_status_error` (`packages/thread-observe/src/completion.ts:86-90`, `:150-178`). `LANE_PILOT_THREAD_SIGNALS=0` disables signal subscriptions; it also leaves polling as the watcher path (`packages/thread-observe/src/signals.ts:84-99`, `src/rooms/core/server/lifecycle-events.ts:22-37`). Poll pauses can be scaled for test environments by `LANE_PILOT_POLL_SCALE` (`packages/kit/src/pace.ts:1-8`).

Lifecycle-event registration is best-effort: BB versions that do not recognize an event produce a log entry while scheduled sweeps remain the recovery mechanism (`src/rooms/core/server/lifecycle-events.ts:26-37`). Archived or deleted PM threads close abandoned runs only when the run has no open attempt (`src/rooms/core/server/lifecycle-events.ts:39-48`).

## Stability and local provider setup

Stability breakers are persisted across plugin reloads and restored only for the same Lane Pilot version (`src/rooms/stability/server/stability.ts:62-82`). A version change discards a prior open breaker because the fault may have shipped fixed (`src/rooms/stability/server/stability.ts:67-80`).

OpenCode v2 runs every session in one shared service per host, so a thread's process environment cannot change its config. Lane Pilot's OpenCode writers get `agent=lane-pilot` (the lane hooks act only under a `lane-` agent) and a git-excluded `.opencode/opencode.jsonc` that turns OpenCode's own compaction off; a project's own config is kept (`src/rooms/core/server/pm-spawn.ts:88-124`, `src/rooms/writer/server/skill-materialize.ts:13-21`).

Codex, OpenCode (`opencode2`) and Cursor helper providers get environment entries only when a thread id and non-PM Lane Pilot role are available. Those entries include `LANE_PILOT_ROLE` and, when host preparation succeeds, a guarded `PATH`. Unknown `prepareBbShim` calls leave the marker but omit the wrapper path; other preparation failures reject environment resolution. If metadata lookup fails, it returns no entries. A Codex writer receives a task-specific `CODEX_HOME` only when strict-user mode is enabled and `workerHome` returns a path; shim preparation is independent of that value (`src/rooms/native-agent/server/helper-bb-shim.ts:71-85`, `:88-105`).

Reload drain covers checkout-writing host methods and `runSandboxedCommand` acceptance checks. Other host calls bypass the drain; an active drain blocks new covered calls while existing calls finish, and an expired drain stops blocking after 20 minutes (`src/rooms/stability/server/deploy-drain.ts:1-25`). A lifecycle drain can reach its deadline with calls still in flight and records `clean: false` with their method names and ages (`src/rooms/stability/server/deploy-drain.ts:65-79`).

Before saving a non-dry-run tick, self-repair drops the oldest eligible signatures while its serialized state exceeds 200 KiB; it does not prune signatures with a worktree or pending spawn. Loading state truncates each stored sample reason to 1,000 characters, and the repair prompt clips displayed incident reasons to 600 characters (`src/rooms/self-repair/server/self-repair.ts:188-195`, `:408-412`, `:345-347`).

The self-repair prompt tells its agent to contact a live PM only when that PM must act; for an idle PM it puts the next action in the repair report (`src/rooms/self-repair/server/self-repair.ts:374-385`). A queued-attempt incident is collected only after two hours with no working attempt in the run and no other recent non-queued attempt; a dependency in a holding state or still inside the blocked-dependency redo window suppresses that incident (`src/rooms/self-repair/server/self-repair.ts:122-129`, `:426-439`, `:483-497`). If a fallback chain ends without acceptance, its last retry-eligible attempt transitions to `blocked` (`src/rooms/writer/server/start.ts:867-871`).

Relay groups task outcomes for a PM. A canceled-only group is recorded as reported without sending a message; a mixed group includes canceled tasks as a count. Within the 24-hour notice window, a due group stays unreported when the PM thread is busy, the busy check fails, or sending fails, so a later sweep can retry it. Outcomes older than the window are marked reported without a notice. The background relay sweep runs every 30 seconds (`src/rooms/relay/server/relay.ts:87-95`, `:391-424`, `:648-655`).

An owner-dated reminder is exempt from the two-hour cap and the repeated time-only reminder chain limit. Only an unobserved, time-only wait is capped; reminders attached to a watched thread or task state also use their event condition instead (`src/rooms/relay/server/relay.ts:246-277`).

Sandboxed checks use `spawnAsync` with `keepEnds`, so excess stdout/stderr is truncated to head-and-tail captures instead of terminating the check; stderr is capped separately after process completion (`src/rooms/verification/sandbox.ts:20-30`, `:210-217`, `:222-242`). The temporary sandbox HOME links installed user tool homes and Playwright browser binaries, while browser cache lock and link metadata remain local to that HOME (`src/rooms/verification/sandbox.ts:103-144`).

Worktree preparation installs from a root lockfile when dependencies are missing and refreshes an existing install when npm's hidden lock is older than the project lock. It mirrors root workspaces and eligible nested packages, refreshing stale nested installs before mirroring; a failed refresh is remembered for that lockfile timestamp (`src/rooms/verification/git-integrate.ts:613-659`, `:685-720`, `:827-857`). The mirror keeps third-party packages linked to the base while copying npm's mutable state and selected generated packages into the worktree (`src/rooms/verification/git-integrate.ts:723-746`).

## Test isolation

Vitest assigns one scratch directory per run to `TMPDIR`, `TEMP`, and `TMP`; teardown removes it, and a later run sweeps directories left by dead processes (`tests/global-setup.ts:9-35`, `tests/tmpdir-isolation.test.ts:7-17`). Node files that mock modules and selected UI files run in isolated Vitest projects; the shared UI matrix gets a 60-second test timeout and empties the DOM before and after each test (`vitest.config.ts:4-32`, `tests/ui-matrix/helpers.tsx:6-26`).

`scripts/test-full.sh` keys success receipts by the committed tree hash and Node version. A dirty tracked tree still runs Vitest but does not write a receipt; an existing receipt skips the full run for the same key (`scripts/test-full.sh:2-18`). The record-and-guard helper records raw hook identity and forwards a normalized Lane Pilot PM marker to the guard process (`scripts/record_and_guard.py:19-49`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Orchestration and execution data](data-model/orchestration.md)
- [Lane Pilot overview](overview.md)
