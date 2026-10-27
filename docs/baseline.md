---
title: The baseline before a writer and the regression pass after acceptance
type: component
created: 2026-10-22
updated: 2026-10-27
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
  - tests/contract-lint-empty-check.test.ts
  - tests/baseline/logic.test.ts
---

# The baseline before a writer and the regression pass after acceptance

TL;DR: before a task's first writer starts, its `verification[]` runs once on the base, so the PM knows which checks were already green («already built?») and which are red; after the merge, the checks that were green on the base and are red on main are named. Every night the checks of the last accepted tasks run again on the current main, and a check that was green at acceptance and is red now is bisected to the commit and the task that broke it. Nothing here reverts or merges anything. SMA atlas delta D1-3 and D1-2.

## How it works

1. Before the first writer, preflight reads baseline settings and task checks, skips inapplicable attempts, and reserves the project's baseline slot (`src/rooms/writer/server/start.ts:560-565`, `src/rooms/baseline/server/baseline.ts:62-85`).
2. It builds a throwaway worktree at the task's base, runs uncached eligible checks, then stores the check outcomes and verdict (`src/rooms/baseline/server/baseline.ts:82-92`, `:95-149`, `src/rooms/baseline/store.ts:1-80`).
3. After merge, the finish path sends verification results to `afterMerge`, which records checks that turned red on main (`src/rooms/writer/server/finish.ts:882-910`, `src/rooms/baseline/server/baseline.ts:181-192`).
4. The regression pass selects recent accepted tasks, runs eligible checks on current main, confirms a red check on the task's merge commit, then bisects within its configured bound and stores a finding (`src/rooms/baseline/server/regress.ts:95-132`, `:183-202`).
5. The baseline and regression RPC methods expose status, run, list, and close operations (`src/rooms/baseline/server/rpc.ts:6-13`).

| Mode or state | Branch and failure handling |
|---|---|
| `baseline.already_built=notify` | Reports that every check already passes and continues to the writer; this is the default (`src/rooms/baseline/logic.ts:24`, `:35-41`, `src/rooms/baseline/server/baseline.ts:161-168`). |
| `baseline.already_built=stop` | Blocks the attempt and returns the base evidence to the PM (`src/rooms/baseline/logic.ts:35-41`, `src/rooms/baseline/server/baseline.ts:161-168`). |
| Red-on-base gate | For configured risk levels, all checks passing on base blocks the task; skipped or unknown checks prevent the all-green conclusion (`src/rooms/baseline/logic.ts:1-100`). |
| Regression check red on task merge | Records `unstable`; it is not bisected (`src/rooms/baseline/server/regress.ts:183-193`). |
| Worktree, host, or check trouble | Records an unknown result and allows writer start to continue (`src/rooms/baseline/server/baseline.ts:103-129`, `:150-152`). |

## The baseline (D1-3)

### How it works

1. Writer start invokes preflight before reusing an area writer or spawning a fresh writer only when there is no writer thread, the turn was not already sent, the workspace is not a live folder, and the task is not a mainfix (`src/rooms/writer/server/start.ts:600-605`).
2. Preflight estimates check duration, filters checks that exceed the cap or need secrets, runs eligible checks on a throwaway base worktree, and stores the result (`src/rooms/baseline/server/baseline.ts:82-110`, `:132-149`).
3. The already-built and red-on-base policies decide whether the writer proceeds or the attempt blocks; preflight errors are logged and do not throw (`src/rooms/baseline/server/baseline.ts:132-152`, `src/rooms/baseline/logic.ts:1-100`).

| Mode or failure | Result |
|---|---|
| `notify` | Continues and tells the PM that all checks already passed on base; this is the default (`src/rooms/baseline/logic.ts:24`, `:35-41`, `src/rooms/baseline/server/baseline.ts:161-168`). |
| `stop` | Blocks the attempt with the baseline evidence (`src/rooms/baseline/logic.ts:35-41`, `src/rooms/baseline/server/baseline.ts:161-168`). |
| All required checks green for a gated task | Blocks under the red-on-base policy (`src/rooms/baseline/logic.ts:1-100`). |
| Error or timeout | Records an unknown/partial result and lets writer start continue (`src/rooms/baseline/server/baseline.ts:113-129`, `:150-152`). |

`services.baseline.preflight` is called in `startWriterTask` after admission waits and before the area's hot writer or fresh writer is selected. It is skipped when a writer thread already exists, `turnSent` is true, the workspace is a live folder, or the task is a mainfix. Mainfix checks have their own current-main preflight; baseline preflight errors are logged and do not throw (`src/rooms/writer/server/start.ts:600-615`, `src/rooms/baseline/server/baseline.ts:132-152`).

### `createBaseline`

1. It reads project/run-scoped settings, returns without a record when baseline is disabled or the task has no verification checks, and reuses a prior same-check record unless its action was `stopped` (`src/rooms/baseline/server/baseline.ts:38-40`, `:62-71`).
2. It asks the project host for the base commit. A missing Git base records skipped checks and proceeds; otherwise it retrieves cached command results and plans uncached checks under the total and per-check time cap using historical duration estimates (`src/rooms/baseline/server/baseline.ts:43-47`, `:72-93`).
3. If checks must run, it acquires one baseline slot per project, creates a worktree at that base, runs the planned checks, maps host errors to `unknown` and exit results to `green` or `red`, then releases the slot and removes the worktree. The await is bounded by `2 × timeCap + 60` seconds; late results become unknown while cleanup continues (`src/rooms/baseline/server/baseline.ts:95-129`).
4. Before applying `already_built`, it stops checks proven unrunnable or checks red only in files outside the task's ownership. It also stops tasks subject to `checks.require_red_on_base` when their checks are vacuous on the base (`src/rooms/baseline/server/baseline.ts:132-159`).
5. It records the verdict and action. An `already_built` result notifies the PM; `notify` proceeds, while `stop` returns a `verdict_block`. Any unexpected exception is logged and returns `stop: null`, allowing the writer start to continue (`src/rooms/baseline/server/baseline.ts:161-171`).

| Condition or mode | Outcome | Failure behavior |
|---|---|---|
| Disabled (`timeCapSec=0`), no checks, or matching prior non-stopped answer | No new baseline run; writer continues (`src/rooms/baseline/server/baseline.ts:65-71`). | Settings lookup failure uses parsed defaults (`:38-40`). |
| No Git base | Records skipped/unknown evidence and proceeds (`src/rooms/baseline/server/baseline.ts:74-80`). | Host lookup errors are treated as no ready base (`:43-47`). |
| Check/worktree/host failure or timeout | Records unknown checks and proceeds unless an independent gate stops the task (`src/rooms/baseline/server/baseline.ts:103-129`). | Recording failure is logged; the result may have no saved row (`:49-55`). |
| Unrunnable/outside-owned red check or required-red gate | Records `stopped` and returns a block before writer start (`src/rooms/baseline/server/baseline.ts:132-159`). | PM notice send errors are swallowed; the task remains stopped. |
| `already_built=notify` / `stop` | Notify sends the PM a message and proceeds; stop returns a block with evidence (`src/rooms/baseline/server/baseline.ts:161-168`). | A PM send failure does not change the proceed/stop result (`:167`, `:179-188`). |

- **Where it runs.** A throwaway worktree of the base checkout's HEAD on the project's host (`rollback.kit.makeWorktree`, dependencies linked like a writer's), the checks through the same runner as the acceptance (`services.runVerification`: the host sandbox, a failing check run once more). The worktree is removed afterwards. One baseline at a time per project (a pool slot `baseline:<project>`).
- **What is bounded.** `baseline.time_cap_sec` (default 300, 0 turns the baseline off) is the sum of the estimated durations of the checks that run. The estimate is the p95 of the check's last green runs (`lane_pilot_check_duration`) when there are three, else a nominal 30 s or its own `timeout_sec` when lower. A check over the cap, or one that carries `secrets`, is skipped and says so; the rest are taken in order while their estimates fit. Each check is cut at `min(its timeout, the cap)`, and the whole wait at `2 × cap + 60 s` (a run that outlives it finishes and removes its worktree on its own, and the attempt starts without an answer).
- **A known answer is not asked again.** The answer to «this command on this commit» does not change: a retry, a redispatch (`.2`) or a sibling task starting from the same base reuses it (`cachedChecks`), and the checks it ran are marked `cached`.
- **The record.** `lane_pilot_baseline`: base sha, per check `green | red | skipped | unknown` with the end of the output of a red one, `verdict` (`already_built` only when every check ran and passed; `partial`, `red`, `unknown`), `action` (`proceed | notified | stopped`), the duration. `bb lane-pilot baseline <task-id>` and RPC `baseline_status` print it; the acceptance card (`task_acceptance_card`) carries it as `baseline` and shows the block «Checks on the base before the writer».
- **Mode `baseline.already_built`** (project setting, `notify` by default): `notify` sends the PM one message (all N checks already pass on the base, the list, what to do) and the writer starts; `stop` ends the attempt before any writer, `blocked` with `verdict_block: baseline already_built: …` (the contract class: the PM's to settle, never redone as it is) and the PM gets the evidence. A weak check (`node --test <missing file>` exits 0) makes a false «already built»: that is why `notify` is the default.
- **Red before green** (`checks.require_red_on_base`: `off` | `medium` | `high`, default `medium`, catalog row s478). A check that is green on the base proves nothing about the work (the planted-defect scorecard: 11 of 36 defects escaped every code check; 69% of bench candidates already passed on the bare base). When a task of risk at or above the setting has every check green on the base (all of them ran and passed; a skipped or unknown check keeps the claim back), the attempt does not start, whatever `baseline.already_built` says: `blocked` with `verdict_block: no_red_on_base: …` (the contract class), the baseline row `action stopped`, and the PM gets one message naming the vacuous checks and what to add: a check that names the new file or behaviour (`test -f <new file>`, `grep -q '<new symbol>' <file>`, a targeted test that fails now). Kinds `refactor`, `docs`, `research` and `check` are never asked (`NO_RED_KINDS`); a baseline turned off (`baseline.time_cap_sec` 0) or a folder without git skips the gate too. A task sent again by the PM under the same id with other checks, or one this gate stopped, is asked again (the answers of the base are cached, so only a new command runs). The dispatch tool's instructions carry the same line with an example, and the contract lint flags `test -f` / `[ -f … ]` / `ls` on a file the base already has (`verification_existence_on_base`: an error when every check of a task of risk medium or more is such, a warning otherwise).
- **What turned red.** `checkMainAfterMerge` hands the task's checks on main to `baseline.afterMerge`: checks green on the base and red now are written on the baseline row (`after_json.turnedRed`), shown on the acceptance card, and named in the PM's mainfix message. A host error is logged and excluded from code-failure repair; permission and ownership failures are reported to the PM as machine incidents, and a mainfix task that leaves main red is reported without starting another repair (`src/rooms/writer/server/finish.ts:874-918`, `src/rooms/baseline/server/baseline.ts:181-192`).

## The regression pass (D1-2)

### How it works

1. Select recent accepted tasks and eligible checks, excluding tasks without a merge commit or usable checks (`src/rooms/baseline/server/regress.ts:95-132`).
2. Run each check on current main within per-check and overall budgets; when a check is red, rerun it at the task's merge commit to distinguish an unstable check from a regression (`src/rooms/baseline/server/regress.ts:204-260`, `:183-202`).
3. Bisect a confirmed regression within the configured commit limit, store the finding, and expose it through list/close routes (`src/rooms/baseline/server/regress.ts:138-158`, `:193-202`, `src/rooms/baseline/server/rpc.ts:7-13`).

`createRegression` builds a pass that reads settings, chooses candidate accepted tasks, groups them by host/checkout, reads current main, and creates a shared main worktree per checkout. It runs each distinct eligible check once, compares red checks at the task's merge commit, and bisects only checks green at merge. Green checks close open findings; non-dry runs persist the pass summary. Missing Git, no eligible candidate, worktree errors, abort/disposal, and time-budget exhaustion are reported as skipped work (`src/rooms/baseline/server/regress.ts:70-78`, `:96-135`, `:207-280`).

| Option or result | Branch behavior | Outcome or failure |
|---|---|---|
| `plan` | Returns after candidate selection, before worktree/check execution (`src/rooms/baseline/server/regress.ts:217-225`). | Report contains selected/skipped candidates and no findings. |
| `dryRun` | Runs checks but does not close, insert, settle, or persist findings/pass rows (`src/rooms/baseline/server/regress.ts:170-183`, `:257-278`). | Existing rows are observed without mutation. |
| Red on main, green at task merge | Classifies as regression, then attempts bounded `git bisect` and stores the culprit/evidence (`src/rooms/baseline/server/regress.ts:138-159`, `:184-204`). | Bisect can be skipped, fail, find no commit, or name the first bad commit. |
| Red on main and red at task merge | Classifies `unstable` and skips bisect (`src/rooms/baseline/server/regress.ts:184-196`). | If the merge-check worktree cannot be made, the pass adds an unconfirmed note and still attempts the bounded bisect (`src/rooms/baseline/server/regress.ts:187-196`). |
| Green again on main or task reverted | Closes the open finding or settlement (`src/rooms/baseline/server/regress.ts:218-222`, `:257-262`). | Close failures do not create a replacement finding. |

| Mode or failure | Result |
|---|---|
| `--plan` | Selects and prints candidates without running checks (`src/rooms/baseline/server/regress.ts:214-222`). |
| `--dry-run` | Runs checks but writes no findings and does not bisect (`src/rooms/baseline/server/regress.ts:169-199`, `:204-221`). |
| Red at task merge | Marks the check `unstable`; no regression bisect is run (`src/rooms/baseline/server/regress.ts:183-193`). |
| Bisect range too large | Records the finding without a culprit commit (`src/rooms/baseline/server/regress.ts:138-152`). |

`bb lane-pilot regress [project-id] [--dry-run] [--plan] [--force] [--last N] [--days K]`, RPC `regress_run`, and a nightly schedule `regress-nightly` at 03:25 (every project with accepted work in the last 60 days unless its `regress.nightly` is `off`).

1. **Which tasks.** The last `regress.last_n` (30) distinct tasks with an accepted attempt in the last `regress.last_days` (14) days. A task is left out, with the reason in the report, when it was reverted (a merged `revert` receipt), has no `verification[]`, has no merge commit (`rollback.kit.changeOf`: the record, else the attempt trailer in main), or has no check that is both cheap and was green at acceptance (the verification stage receipt says which commands passed; without one, all of them).
2. **Which checks.** Cheap ones: the estimate (above) within `regress.check_cap_sec` (120), no secrets. Each is cut at that cap.
3. **How.** One throwaway worktree of the project's current main per checkout; the checks of every task run there, a command shared by several tasks runs once; the pass stops starting tasks after `regress.budget_sec` (1800). A main that has not moved since the last pass (same HEAD, under 20 hours) is not run again (`--force` overrides). `--plan` only picks and prints; `--dry-run` runs the checks and reports, writes nothing and bisects nothing.
4. **A red check** is first run in a worktree of the task's own merge commit: red there too is `unstable` (flaky or the machine; never on the morning list, never bisected). Green there is a `regression`: `git bisect run` between the merge and main in a scratch worktree (`gateBisect`, the integration gate's host call; the range is checked with `git merge-base --is-ancestor` and `rev-list --count`, and a range over `2^regress.bisect_steps` (9) commits is not bisected: the finding says so). The first bad commit is read for its `Lane-Pilot-Attempt` trailer or its task id (the commit, else the merge that contains it), which names the culprit task. The finding (`lane_pilot_regression`) keeps the green and red commits, the culprit commit, task and subject, the end of the output and the files the culprit task shares with the broken one (a later deliberate change of the same file, such as a release's version pin, looks the same as a break; the code cannot tell, the evidence says which files).
5. **A finding closes** by itself when the check is green again, or the task is reverted; by hand with `bb lane-pilot regress-close <id> <reason>`. A finding settled by hand is not opened again while the check stays red; once the check is green the settlement is released.
6. **The morning list.** Line 2 of `composeMorningList` / `scripts/lp-morning.sql` ends with «Сломано после приёмки: N (task ← commit, …)» for the open `regression` findings (up to three named). The night loop reads `bb lane-pilot regressions [project]` (RPC `regress_list`) and may take a finding as a wall. The pass never reverts, merges or dispatches.

## Settings

The baseline server API is assembled by `baselineRpc`: `baseline_status` returns a task's stored baseline rows, while `regress_run`, `regress_list`, and `regress_close` delegate to the regression service (`src/rooms/baseline/server/rpc.ts:6-13`). The baseline service compares checks before and after merge; regression creation selects recent accepted tasks, executes eligible checks, confirms red checks on the task merge, then bisects a bounded commit range (`src/rooms/baseline/server/baseline.ts:33-92`, `src/rooms/baseline/server/regress.ts:69-128`). The acceptance card reads the baseline receipt and derives the baseline display alongside stage evidence (`src/rooms/acceptance/card.ts:26-85`).

`checks.require_red_on_base` has a catalog row (s478, section stages). Plain project settings (no catalog row yet): `baseline.already_built` (`notify` | `stop`), `baseline.time_cap_sec`, `regress.nightly` (`on` | `off`), `regress.last_n`, `regress.last_days`, `regress.check_cap_sec`, `regress.budget_sec`, `regress.bisect_steps`. A bad value is the default, never a stopped task (`parseBaselineSettings`, `parseRegressSettings`).

## Acceptance card projection

`buildAcceptanceCard(db, {runId, taskId})` returns `null` when either task or run is absent. Otherwise it assembles the task contract, risk, captured Git base, ordered pipeline receipts with code/advisory proof labels, missing/skipped stage explanations, gate events, plan-fact evidence, baseline evidence, and attempt cost from existing storage records (`src/rooms/acceptance/card.ts:26-88`).

1. It indexes stage receipts by stage, projects plan-fact fields only when a receipt exists, and adds absent or skipped stages to `notRun` (`src/rooms/acceptance/card.ts:30-55`).
2. It reads gate events in id order and obtains base and attempt metrics; cost sums only measured attempts and keeps partial/not-measured notes (`src/rooms/acceptance/card.ts:57-64`).
3. It appends the baseline verdict, action, mode, bounded check notes, and post-merge turned-red evidence when a baseline record exists (`src/rooms/acceptance/card.ts:66-82`).
4. A missing task or run returns `null`; database read errors are not caught in this function (`src/rooms/acceptance/card.ts:26-32`, `:57-67`).

## Tables

Appended last to `migrations`: `lane_pilot_baseline`, `lane_pilot_regression` (one open row per task and command), `lane_pilot_regress_pass` (one row per project per pass).

## Live evidence

2026-10-22, the sandbox project's real history cloned, the real host handlers and the macOS sandbox in one process (a one-off harness of that session, not kept in the repository): a task whose `npm test` already passes → `already_built`, `notify` and `stop` both; a new task → 1 green, 1 red; A merged green, then B removes A's file: the pass finds A red, confirms it green at its merge, and `git bisect` names B's commit and task in 4 s; a fix commit closes the finding. On real projects, `--dry-run` on the current main of `bb-plugin-office-viewer` (12 tasks, 9 commands, 25 s) and `bb-plugin-pokecut-theme` (12 tasks, 4 commands, 4 s): the checkouts and their worktree lists unchanged; two red findings, both version pins of release tasks (see the shared-files note above).
