---
title: The baseline before a writer and the regression pass after acceptance
type: component
created: 2026-10-22
updated: 2026-10-22
status: active
confidence: medium
tags: [baseline, regression, bisect, sma, acceptance]
sources:
  - src/rooms/baseline/migrations.ts
  - src/rooms/baseline/logic.ts
  - src/rooms/baseline/store.ts
  - src/rooms/baseline/server/baseline.ts
  - src/rooms/baseline/server/regress.ts
  - src/rooms/baseline/server/cli.ts
  - src/rooms/baseline/server/rpc.ts
  - src/rooms/rollback/server/rollback.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/acceptance/card.ts
  - src/rooms/policy/morning.ts
  - scripts/lp-morning.sql
  - tests/baseline/baseline.test.ts
  - tests/baseline/regress.test.ts
  - tests/baseline/start.test.ts
  - tests/baseline/logic.test.ts
---

# The baseline before a writer and the regression pass after acceptance

TL;DR: before a task's first writer starts, its `verification[]` runs once on the base, so the PM knows which checks were already green («already built?») and which are red; after the merge, the checks that were green on the base and are red on main are named. Every night the checks of the last accepted tasks run again on the current main, and a check that was green at acceptance and is red now is bisected to the commit and the task that broke it. Nothing here reverts or merges anything. SMA atlas delta D1-3 and D1-2.

## The baseline (D1-3)

`services.baseline.preflight` is called in `startWriterTask` (`src/rooms/writer/server/start.ts`) right after the task passed the waits and before the area's hot writer or a fresh writer is asked. It is skipped for a mainfix (it has its own preflight: its checks must still be red), for a folder without git (no base to run on), and for an attempt that arrives with a writer thread already (a reload, a PM answer). It never throws: any trouble is a record and the attempt starts.

- **Where it runs.** A throwaway worktree of the base checkout's HEAD on the project's host (`rollback.kit.makeWorktree`, dependencies linked like a writer's), the checks through the same runner as the acceptance (`services.runVerification`: the host sandbox, a failing check run once more). The worktree is removed afterwards. One baseline at a time per project (a pool slot `baseline:<project>`).
- **What is bounded.** `baseline.time_cap_sec` (default 300, 0 turns the baseline off) is the sum of the estimated durations of the checks that run. The estimate is the p95 of the check's last green runs (`lane_pilot_check_duration`) when there are three, else a nominal 30 s or its own `timeout_sec` when lower. A check over the cap, or one that carries `secrets`, is skipped and says so; the rest are taken in order while their estimates fit. Each check is cut at `min(its timeout, the cap)`, and the whole wait at `2 × cap + 60 s` (a run that outlives it finishes and removes its worktree on its own, and the attempt starts without an answer).
- **A known answer is not asked again.** The answer to «this command on this commit» does not change: a retry, a redispatch (`.2`) or a sibling task starting from the same base reuses it (`cachedChecks`), and the checks it ran are marked `cached`.
- **The record.** `lane_pilot_baseline`: base sha, per check `green | red | skipped | unknown` with the end of the output of a red one, `verdict` (`already_built` only when every check ran and passed; `partial`, `red`, `unknown`), `action` (`proceed | notified | stopped`), the duration. `bb lane-pilot baseline <task-id>` and RPC `baseline_status` print it; the acceptance card (`task_acceptance_card`) carries it as `baseline` and shows the block «Checks on the base before the writer».
- **Mode `baseline.already_built`** (project setting, `notify` by default): `notify` sends the PM one message (all N checks already pass on the base, the list, what to do) and the writer starts; `stop` ends the attempt before any writer, `blocked` with `verdict_block: baseline already_built: …` (the contract class: the PM's to settle, never redone as it is) and the PM gets the evidence. A weak check (`node --test <missing file>` exits 0) makes a false «already built»: that is why `notify` is the default.
- **What turned red.** `checkMainAfterMerge` (`src/rooms/writer/server/finish.ts`) hands the task's checks on main to `baseline.afterMerge`: those green on the base and red now are written on the baseline row (`after_json.turnedRed`), shown on the acceptance card, and named in the PM's mainfix message («… passed on the base before this task»).

## The regression pass (D1-2)

`bb lane-pilot regress [project-id] [--dry-run] [--plan] [--force] [--last N] [--days K]`, RPC `regress_run`, and a nightly schedule `regress-nightly` at 03:25 (every project with accepted work in the last 60 days unless its `regress.nightly` is `off`).

1. **Which tasks.** The last `regress.last_n` (30) distinct tasks with an accepted attempt in the last `regress.last_days` (14) days. A task is left out, with the reason in the report, when it was reverted (a merged `revert` receipt), has no `verification[]`, has no merge commit (`rollback.kit.changeOf`: the record, else the attempt trailer in main), or has no check that is both cheap and was green at acceptance (the verification stage receipt says which commands passed; without one, all of them).
2. **Which checks.** Cheap ones: the estimate (above) within `regress.check_cap_sec` (120), no secrets. Each is cut at that cap.
3. **How.** One throwaway worktree of the project's current main per checkout; the checks of every task run there, a command shared by several tasks runs once; the pass stops starting tasks after `regress.budget_sec` (1800). A main that has not moved since the last pass (same HEAD, under 20 hours) is not run again (`--force` overrides). `--plan` only picks and prints; `--dry-run` runs the checks and reports, writes nothing and bisects nothing.
4. **A red check** is first run in a worktree of the task's own merge commit: red there too is `unstable` (flaky or the machine; never on the morning list, never bisected). Green there is a `regression`: `git bisect run` between the merge and main in a scratch worktree (`gateBisect`, the integration gate's host call; the range is checked with `git merge-base --is-ancestor` and `rev-list --count`, and a range over `2^regress.bisect_steps` (9) commits is not bisected: the finding says so). The first bad commit is read for its `Lane-Pilot-Attempt` trailer or its task id (the commit, else the merge that contains it), which names the culprit task. The finding (`lane_pilot_regression`) keeps the green and red commits, the culprit commit, task and subject, the end of the output and the files the culprit task shares with the broken one (a later deliberate change of the same file, such as a release's version pin, looks the same as a break; the code cannot tell, the evidence says which files).
5. **A finding closes** by itself when the check is green again, or the task is reverted; by hand with `bb lane-pilot regress-close <id> <reason>`. A finding settled by hand is not opened again while the check stays red; once the check is green the settlement is released.
6. **The morning list.** Line 2 of `composeMorningList` / `scripts/lp-morning.sql` ends with «Сломано после приёмки: N (task ← commit, …)» for the open `regression` findings (up to three named). The night loop reads `bb lane-pilot regressions [project]` (RPC `regress_list`) and may take a finding as a wall. The pass never reverts, merges or dispatches.

## Settings

Plain project settings (no catalog row yet): `baseline.already_built` (`notify` | `stop`), `baseline.time_cap_sec`, `regress.nightly` (`on` | `off`), `regress.last_n`, `regress.last_days`, `regress.check_cap_sec`, `regress.budget_sec`, `regress.bisect_steps`. A bad value is the default, never a stopped task (`parseBaselineSettings`, `parseRegressSettings`).

## Tables

Appended last to `migrations`: `lane_pilot_baseline`, `lane_pilot_regression` (one open row per task and command), `lane_pilot_regress_pass` (one row per project per pass).

## Live evidence

2026-10-22, the sandbox project's real history cloned, the real host handlers and the macOS sandbox in one process (`scripts/live-d1.ts`): a task whose `npm test` already passes → `already_built`, `notify` and `stop` both; a new task → 1 green, 1 red; A merged green, then B removes A's file: the pass finds A red, confirms it green at its merge, and `git bisect` names B's commit and task in 4 s; a fix commit closes the finding. On real projects, `--dry-run` on the current main of `bb-plugin-office-viewer` (12 tasks, 9 commands, 25 s) and `bb-plugin-pokecut-theme` (12 tasks, 4 commands, 4 s): the checkouts and their worktree lists unchanged; two red findings, both version pins of release tasks (see the shared-files note above).
