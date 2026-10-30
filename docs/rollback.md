---
title: Rolling work back, trusted tooling and pause
type: component
created: 2026-10-22
updated: 2026-10-30
status: active
confidence: low
tags: [rollback, reverify, revert, pause, trusted-tooling, sma]
sources:
  - src/rooms/rollback/migrations.ts
  - src/rooms/rollback/store.ts
  - src/rooms/rollback/server/rollback.ts
  - src/rooms/rollback/server/cli.ts
  - src/rooms/rollback/server/rpc.ts
  - src/rooms/verification/git-rollback.ts
  - src/rooms/verification/git-integrate.ts
  - src/rooms/tasks/trusted-tooling.ts
  - src/rooms/runs/server/runs-halt.ts
  - src/rooms/runs/server/runs-pause.ts
  - src/rooms/runs/server/writer-stop.ts
  - src/rooms/runs/server/cancel.ts
  - tests/rollback.test.ts
  - tests/verification/git-rollback.test.ts
  - tests/trusted-tooling.test.ts
  - tests/run-pause-start.test.ts
  - tests/run-pause-stop.test.ts
  - src/rooms/storage/database.ts
  - src/rooms/writer/server/spawn.ts
  - src/rooms/writer/server/sticky.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/tasks/task-v2.ts
  - src/rooms/tasks/task-base.ts
  - src/rooms/writer/server/update-task.ts
  - src/rooms/tasks/validate-output.ts
  - src/rooms/writer/server/verify.ts
  - src/rooms/tools/server/cli.ts
  - src/rooms/stability/server/stability.ts
  - server.ts
  - src/rooms/contracts/host.ts
---

# Rolling work back, trusted tooling and pause

TL;DR: every attempt has its base and its changed files on record, accepted work can be checked again (`reverify`) or taken out (`revert`) with one command, hooks and check scripts are out of a writer's reach unless the task names them, and a run can be paused at a stage boundary without cancelling anything.

## Purpose

SMA wall 3 says «stopped» has two conditions; wall 4 says every job rolls back to the state before it and the record names that state without opening the workspace; rule 9 says a stop is a confirmed exit and the work returned. Before this page's work the record could say a job *could* be rolled back, not *to what*: `lane_pilot_task_git_base` holds one ownership base per task, not one per attempt, and no merge commit was kept (`src/rooms/storage/database.ts:219-227`). All four items are protection from mistakes: no login, no form, no caller check.

## How it works

1. The record is filled where each fact becomes known: the spawn writes the base commit, the merge writes main's previous HEAD and the merge commit, a failed attempt's worktree state and patch are written before the worktree is removed, and an attempt older than the record is found in main by its merge trailer (`src/rooms/verification/git-integrate.ts:288`, `src/rooms/writer/server/start.ts:340-343`, `src/rooms/verification/git-rollback.ts:69-99`).
2. `reverify` builds a fresh worktree of the accepted attempt's merge commit and reruns the task's `verification[]` item by item; exit 0 only when every item passes (`src/rooms/rollback/server/rollback.ts:224-262`).
3. `revert` reverts the accepted merge commits in a scratch worktree, runs the checks that can block and the project gate, then merges through the base-checkout lock; a conflict aborts the whole revert and refuses with the next step (`src/rooms/verification/git-rollback.ts:104-138`, `src/rooms/rollback/server/rollback.ts:265-345`).
4. Trusted tooling is appended to `never_touch` whenever the contract is normalised and again when the task lands in a repository; the ownership and output gates refuse a hit with the one thing to do (`src/rooms/tasks/trusted-tooling.ts:10`, `:52-75`, `:103-108`).
5. `pause` sets a flag in the plugin's key-value store: a not-started task waits before it takes any slot, a running attempt finishes its stage and waits, parked tasks stay parked; `resume` clears the flag (`src/rooms/runs/server/runs-pause.ts:38-53`).
6. `cancel` asks the writer thread for up to 30 seconds, writes the worktree state down, then cancels; cleanup saves uncommitted edits and unmerged commits as a patch before removal (`src/rooms/runs/server/writer-stop.ts:13-27`, `src/rooms/verification/git-integrate.ts:745-761`).

| Operation | Modes | Failure |
|---|---|---|
| `reverify <task\|attempt>` | The task's latest accepted attempt, or the one named. | Refusal receipts with the next step: no accepted attempt, no `verification[]`, no merge commit, reverted since (`src/rooms/rollback/server/rollback.ts:224-262`). |
| `revert <task>` | `--dry-run` stops before the merge; `--no-gate` skips the project gate. | A conflict aborts the revert, drops the worktree and refuses with the files, the later commits and the tasks to revert first (`src/rooms/rollback/server/rollback.ts:281-312`); a check red on the reverted tree and green before blocks. |
| `pause <run-id>` / `resume <run-id>` | Flag in KV, kept across a reload; the older `resume <project-id>` reconcile is unchanged. | None: the answer lists what runs and what waits; a paused run's wall budget keeps counting. |
| Trusted tooling | A pattern is left out when the task names something inside it in `owns_paths`, `expected_outputs` or `files[]`. | The gate refusal names the hits and the fix (`src/rooms/tasks/trusted-tooling.ts:103-108`). |

## How it works

1. When an attempt takes a worktree, its base commit is written to the record (`src/rooms/writer/server/spawn.ts:315`); a BB environment or a folder in place asks git once, in the background (`src/rooms/rollback/server/rollback.ts:75-84`); a folder without git is skipped.
2. When the merge lands, the finish stage writes main's HEAD before the merge, the merge commit and the changed files (`src/rooms/writer/server/finish.ts:729`, `src/rooms/rollback/server/rollback.ts:86-100`).
3. When a stop is confirmed, the worktree state is written first, the uncommitted work is saved as a patch, and only then the worktree is removed (`src/rooms/writer/server/start.ts:419-422`).
4. On demand, `reverify` re-runs a task's checks on its recorded merge commit (`src/rooms/rollback/server/rollback.ts:224-262`), and `revert` takes the accepted merge commits out in a scratch worktree and merges the result (`src/rooms/verification/git-rollback.ts:109-138`).
5. A paused run holds new tasks before a slot and running attempts at their stage boundary until resumed (`src/rooms/writer/server/start.ts:454-458`, `:646-647`).

| Mode or state | What differs | Failure |
|---|---|---|
| Git worktree | Full record; `reverify` and `revert` available. | A revert conflict aborts, drops the worktree and names the files and tasks to settle first (`src/rooms/rollback/server/rollback.ts:281-312`). |
| Live folder (no git) | Snapshots and rollback backups; no merge, no revert. | The base ask is skipped; the stop still records the state and saves the patch. |
| BB environment | The base is asked once, in the background. | A missing answer leaves the record's base empty; the stop path is unchanged. |

## The record of an attempt

`lane_pilot_attempt_change` has one row per attempt: `base_sha` (the commit the worktree started from, the first one sticks), `merge_parent` (main right before the merge), `merge_commit`, `outcome`, `changed_json` (files with A/M/D/T, deletions included) and `worktree_json` (what the worktree held when the stop was confirmed or it was returned) (`src/rooms/rollback/migrations.ts:12-37`). The migrations are spread at the end of the list (`src/rooms/storage/database.ts:371`). `lane_pilot_task_receipt` is append only (update and delete triggers refuse) and holds the receipts of `reverify` and `revert` (`src/rooms/rollback/migrations.ts:27-44`).

It is filled where the facts are known:

- A worktree Lane Pilot makes returns the commit it started from, and the spawn writes it down (`src/rooms/verification/git-integrate.ts:357-374`, `src/rooms/writer/server/spawn.ts:315`, `src/rooms/writer/server/spawn.ts:565`). A BB environment, a folder in place or a continued writer asks git once, in the background (`src/rooms/rollback/server/rollback.ts:75-84`, called at `src/rooms/writer/server/spawn.ts:501` and `src/rooms/writer/server/sticky.ts:279`). A folder without git is skipped: nothing is asked of git there.
- The merge returns main's HEAD before it and what it changed (`src/rooms/verification/git-integrate.ts:288`); the finish stage writes both with the merge commit (`src/rooms/writer/server/finish.ts:729`, `src/rooms/rollback/server/rollback.ts:86-100`).
- A failed attempt's worktree: its state is written before the worktree is removed (`src/rooms/writer/server/start.ts:419`), then the saved patch (`src/rooms/writer/server/start.ts:420-422`).
- Work accepted before the record existed is found in main by the attempt trailer every merge carries (`Lane-Pilot-Attempt: <id>`, matched line by line) and recorded on first use (`src/rooms/verification/git-rollback.ts:69-99`, `src/rooms/rollback/server/rollback.ts:165-178`).

`bb lane-pilot changes <task|attempt>` (RPC `task_changes`) prints the record and the receipts.

## `bb lane-pilot reverify <task|attempt>`

Takes the accepted attempt (the task's latest, or the one named), finds its merge commit and starts a fresh worktree of it on the project host. Main's tree before the merge plus the accepted change is exactly the merge commit's tree, so the check runs on «the recorded base plus the accepted change» and not on whatever main became since. It runs the task's `verification[]` with the same runner as the first acceptance, item by item, removes the worktree and keeps a receipt. Exit 0 only when every item passes; `failed` and `error` (the host could not run them) exit 1 and say what to do (`src/rooms/rollback/server/rollback.ts:224-262`). A task that was reverted since says so in the answer (`revertedIn`). Nothing to check (no accepted attempt, no `verification[]`, no merge commit) is a refusal with the next step, also in a receipt.

## `bb lane-pilot revert <task> [--dry-run] [--no-gate]`

1. The accepted attempts' merge commits, newest first (a task already reverted is refused).
2. A scratch worktree of main's current HEAD and `git revert` of those commits in it, a merge commit against its first parent. No reset, no force, no touching main (`src/rooms/verification/git-rollback.ts:104-138`). A conflict aborts the revert, drops the worktree and refuses with the conflicting files and the later commits that touch them, and the tasks to revert first (their commits start with `<task id>: `) (`src/rooms/rollback/server/rollback.ts:281-312`).
3. Checks, only where they mean something. The task's `verification[]` runs on the reverted tree; a command that is red there and was green on the commit before the task blocks, one that is red there and before (it tests the feature itself, or main was red already) is only noted (`src/rooms/rollback/server/rollback.ts:325-345`). The project's checks are the integration gate command, explicit or detected, run on the reverted tree; red there but green on main blocks, red on main too does not (`--no-gate` skips it).
4. `--dry-run` stops here, with a receipt. Otherwise the revert is merged through `gitIntegrate`, the same base-checkout lock every writer merge takes, waiting up to 15 minutes in the queue (`src/rooms/rollback/server/rollback.ts:265-279`), and a `merged` receipt names the revert commit.

Scratch worktrees are removed in every outcome. Every refusal is a receipt with `next` saying what to do.

## Trusted tooling in `never_touch` (P2-4)

`.git/hooks/**`, `.husky/**`, `.claude/**`, `lane-stack/hooks/**` and `.github/workflows/**` are added to every task's `never_touch`, and so are the check scripts its `verification[]` runs (`bash scripts/check.sh`, `node tools/verify.mjs`, `npx tsx bin/probe.ts`, `./gate.sh`; not test files) (`src/rooms/tasks/trusted-tooling.ts:10`, `src/rooms/tasks/trusted-tooling.ts:52-75`). A pattern is left out when the task names something inside it or around it in `owns_paths`, `expected_outputs` or `files[]`; a catch-all like `**` names nothing (`src/rooms/tasks/trusted-tooling.ts:41-46`, `src/rooms/tasks/trusted-tooling.ts:82-94`).

It is applied where the contract is normalised: `validateTaskV2` (dispatch, update, workflows) and again after a task moves into a repository (`src/rooms/tasks/task-v2.ts:50`, `src/rooms/tasks/task-base.ts:94`); an update compares with the old contract as it would be stored now, so no change is invented (`src/rooms/writer/server/update-task.ts:198`). The ownership and output gates then refuse such a change like any `never_touch` hit, and the reason ends with what to do: undo it, or dispatch the task again with that exact path in `owns_paths` (`src/rooms/tasks/validate-output.ts:67`, `src/rooms/writer/server/verify.ts:392`, `src/rooms/tasks/trusted-tooling.ts:103-108`). Not covered: edits to the `scripts` of `package.json` (a path pattern cannot see a diff inside an owned file).

## Pause at a safe boundary (P2-8)

Existing before: `halt_run` (stop everything now), cancel, parked-task restarts. The gap was a run-level pause that takes nothing away.

`bb lane-pilot pause <run-id>` (RPC `pause_run`) sets a flag in the plugin's key-value store; `bb lane-pilot resume <run-id>` (`resume_run`) clears it (`resume <project-id>` is still the older reconcile: a run id is told by its record) (`src/rooms/runs/server/runs-halt.ts:22-36`, `src/rooms/runs/server/runs-pause.ts:38-53`, `src/rooms/tools/server/cli.ts:123-129`). While paused:

- a task that has not started waits before it takes any slot, with its writer stage `pending` and the reason «the run is paused» (`src/rooms/writer/server/start.ts:454-458`);
- a running attempt finishes its current stage (the writer's turn and its checks) and waits before its next attempt or turn (`src/rooms/writer/server/start.ts:646-647`);
- parked tasks are not restarted (`src/rooms/stability/server/stability.ts:214`);
- nothing is cancelled, and a reload keeps the flag.

The answer lists what runs and what waits. A paused run's wall budget keeps counting. Helper stages (pm-read, critique) of a task sent during a pause run as usual; only the writer waits.

## Stop = confirmed exit and work returned (rule 9)

`cancel` used to look once at the thread right after `threads.stop`; a writer still winding down read as «not observed». Now the thread is asked for up to 30 seconds (`src/rooms/runs/server/writer-stop.ts:13-27`, used by `src/rooms/runs/server/cancel.ts:31` and the CLI `cancel`, `src/rooms/tools/server/cli.ts:260`). Only then is the attempt's worktree state written down (`src/rooms/rollback/server/rollback.ts:131-139`, `src/rooms/runs/server/cancel.ts:34`), and then the attempt becomes `canceled`. Cleanup returns the work first: removing a Lane Pilot worktree with `release` saves uncommitted edits and unmerged commits as a patch in `~/.lane-pilot/released` and keeps the worktree when that fails (`src/rooms/verification/git-integrate.ts:745-761`); the failed-attempt path and the sticky-window sweep use it (`src/rooms/writer/server/start.ts:341`, `server.ts:133`).

## Host calls added

`gitWorktreeState`, `gitMergeInfo`, `gitRevertCommits` are new; `gitCreateWorktree` takes an optional `commit` and returns `baseSha`; `gitIntegrate` returns `base` and `changed`; `gitRemoveWorktree` takes `release` and returns `saved` (`src/rooms/contracts/host.ts:25-45`, `src/rooms/contracts/host.ts:76-80`, `src/rooms/contracts/host.ts:93`). All are additive: an older host ignores or omits them, and the record then stays empty for that attempt. The host artifact must be deployed with the plugin for the new calls.

## Verification

Real git in `tests/verification/git-rollback.test.ts` and `tests/rollback.test.ts` (revert merged and refused, checks blocking and not meaningful, gate, dry run, legacy lookup, record); `tests/trusted-tooling.test.ts`; pause and stop in `tests/run-pause-start.test.ts` and `tests/run-pause-stop.test.ts`. Live on the sandbox project's real history: see the changelog entry.
