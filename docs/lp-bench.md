---
title: LP-Bench, the fixed task set
type: component
created: 2026-10-22
updated: 2026-10-30
status: active
confidence: medium
tags: [bench, sma, harness, evaluation]
sources:
  - src/rooms/bench/migrations.ts
  - src/rooms/bench/candidates.ts
  - src/rooms/bench/stratify.ts
  - src/rooms/bench/warmup.ts
  - src/rooms/bench/build.ts
  - src/rooms/bench/store.ts
  - src/rooms/bench/runner.ts
  - src/rooms/bench/compare.ts
  - src/rooms/bench/service.ts
  - src/rooms/bench/cli.ts
  - src/rooms/bench/server/plugin-ports.ts
  - src/rooms/harness/server/trial.ts
  - src/rooms/harness/server/harness.ts
  - scripts/lp-bench.ts
  - tests/bench/build.test.ts
  - tests/bench/runner.test.ts
  - tests/bench/harness-adoption.test.ts
  - src/rooms/bench/types.ts
  - src/rooms/harness/server/store.ts
---

# LP-Bench, the fixed task set

Matvey Maslov's rule (#31448): twenty to fifty real tasks from past runs whose right result is known; the same graph run again with another
model or another edit; three numbers: how many stages passed, what it cost, how long it took; the set is not changed. This is that set
(SMA plan P0-1). Code decides everything: a task passes when its `verification[]` passed and the gates accepted the attempt; no model judges.

## How it works

1. Build loads eligible accepted-task candidates, groups them by stratum and host, warms each candidate by running checks on the base and with the accepted solution applied, and stores a frozen manifest when tasks survive (`src/rooms/bench/build.ts:43-110`, `:125-150`, `src/rooms/bench/store.ts:25-39`).
2. A series verifies the stored manifest, prepares a sandbox checkout at each task's base commit, configures the arm, dispatches each task through the normal pipeline, records outcomes, and finishes the run (`src/rooms/bench/runner.ts:124-137`, `:149-220`, `:229-239`).
3. Comparison pairs task outcomes for two arms; an optional identical-arm noise run marks unstable tasks and adjusts cost/time tolerance (`src/rooms/bench/compare.ts:65-80`, `:85-110`). Harness trial evaluation reads the latest verdict and applies the configured adoption rule (`src/rooms/harness/server/harness.ts:499-523`, `src/rooms/harness/server/trial.ts:51-60`).

| Mode or state | Branch and failure handling |
|---|---|
| Plan-only build | Counts candidates without warm-up or writes (`src/rooms/bench/build.ts:89`, `:137-142`). |
| Dry-run build | Performs planning and warm-up but writes no set (`src/rooms/bench/build.ts:137-142`). |
| Partial build | Warms only requested strata and writes that subset as a version (`src/rooms/bench/build.ts:43-47`, `:139-142`). |
| Warm-up rejection | Stores the candidate's rejection reason; after three consecutive host errors on a host, it stops that host's chain and writes no set (`src/rooms/bench/build.ts:98-112`, `:139-142`). |
| Missing or changed set | Series fails before starting if the version is absent or its stored manifest hash differs (`src/rooms/bench/runner.ts:127-134`). |
| Run budget reached | Remaining tasks are stored as `skipped_budget`; a later run resumes unfinished tasks (`src/rooms/bench/runner.ts:173-182`, `:233-239`, `src/rooms/bench/store.ts:76-83`). |

## The service (`createBench`)

### How it works

1. `createBench(deps)` wires the database, KV, host and pipeline ports into one facade and returns `settings`, `placement`, `configure`, `build`, `lastBuild`, `run`, `noise`, `compare`, `status`, `show`, `prepare`, `armSummary`, `baseline`, `sweep` (`src/rooms/bench/service.ts:14-25`, `:214`).
2. Budgets are read from the hub settings row `bench.*`, which wins over the old KV record, and fall to the built-in defaults (`src/rooms/bench/service.ts:44-50`, `src/rooms/bench/runner.ts:53-54`).
3. Placement — a host id and 0–10 same-set repeats — is stored under the `bench:config` KV key; `configure` rounds budget values to whole positive numbers and validates the repeat bound (`src/rooms/bench/service.ts:28-30`, `:51-79`).
4. Every long job runs under a per-key lock (`build:<version>`, `run:<version>:<arm>`): a second job with the same key is rejected, and a non-waiting call returns `{started:true}` while the job logs its own failure (`src/rooms/bench/service.ts:40-42`, `:81-88`).
5. A series run first closes stuck runs, then repeats the arm up to the asked repeat count (or the placement's `noiseRepeats` for a noise run), stopping the loop when a repeat ends `stopped_budget`, `failed`, `deferred` or `unavailable`; a noise run with at least two complete repeats stores the noise record and stamps the pass rates on every report (`src/rooms/bench/service.ts:110-136`).
6. `armSummary` refuses an unfinished measurement: a running or failed repeat is listed as incomplete, and repeats that did not share one writer clear the arm's writer (`src/rooms/bench/service.ts:139-154`).

| Branch | Outcome |
|---|---|
| Same job key twice | The second call rejects with «<key> is already running» (`src/rooms/bench/service.ts:81-88`). |
| Inconclusive comparison with a harness id | No verdict row is stored; an adopt-by-bench decision reads only recorded verdicts (`src/rooms/bench/service.ts:169-172`). |
| Budget value not a positive number | `configure` throws; hub fields keep whole numbers (`src/rooms/bench/service.ts:62-70`). |
| `noiseRepeats` outside 0–10 | `configure` throws (`src/rooms/bench/service.ts:73-76`). |

## The set

### How it works

1. Load and filter candidates, partition by stratum, warm eligible tasks on their host, then save the ordered manifest and rejection report (`src/rooms/bench/build.ts:43-47`, `:65-110`, `:125-150`).
2. Do not write in plan-only or dry-run mode; do not write a set when no task survives or any host is lost (`src/rooms/bench/build.ts:137-142`).

| Build mode or failure | Result |
|---|---|
| Plan-only or dry-run | Returns a report without storing a set (`src/rooms/bench/build.ts:137-142`). |
| Candidate rejection | Adds its reason to the build report and rejection list (`src/rooms/bench/build.ts:98-107`). |
| Host lost | Stops that host after three consecutive host errors and suppresses set creation (`src/rooms/bench/build.ts:76-112`, `:137-142`). |

`buildSet` loads candidate history, assigns each task to the first matching requested stratum, and serializes warm-up work per host while different hosts run concurrently. It stops a stratum after quota and hard-candidate needs are met, its trial cap is reached, free disk falls below the configured floor, or the host reports three consecutive host errors. It writes a set only outside plan-only and dry-run modes, when at least one task survives and no host was lost; a requested partial build is persisted as its own version. `insertSet` stores the version, manifest hash, build report and task rows transactionally, and the server ports provide host, project-name, sandbox-name, and host-resolution inputs (`src/rooms/bench/build.ts:43-110`, `:111-150`, `src/rooms/bench/store.ts:26-41`, `src/rooms/bench/server/plugin-ports.ts:15-74`).

- **Selection** (`src/rooms/bench/candidates.ts:47`): the accepted tasks with `initial_head_sha`, their first accepted attempt (`hard` when it is not
  attempt 1), in the projects the owner allows (`src/rooms/bench/types.ts:11-20`: SelfyStudio, BB-сервис plugins, cakekeeper; no client or IP folders). A
  contract is refused with a reason (`src/rooms/bench/candidates.ts:18`): fewer than two checks, `depends_on`, secrets, a check that needs the network or a login
  (curl, ssh, docker, `npm install`, playwright …), an empty check (`emptyCheckReason` of the contract lint), drill tasks, sandbox projects
  (`isSandboxProjectName`).
- **Strata** (`src/rooms/bench/stratify.ts:10`): 10 SelfyStudio pages, 8 features, 2 other, 6 BB-сервис, 4 cakekeeper. At least 30% of each stratum is «hard»
  (`chooseFinal`, `src/rooms/bench/stratify.ts:47`) and the risks rotate low, medium, high. Candidates are tried hard and easy interleaved (`warmOrder`, 4 hard in 10).
  A hash of the seed, not a random number, orders them: the same build picks the same tasks.
- **Warm-up** (`src/rooms/bench/warmup.ts:67`): the solution is the merge commit of the accepted attempt (found by its `Lane-Pilot-Attempt:` trailer, else by the
  `<task id>: ` subject). In a fresh clone at `initial_head_sha` the contract's checks run on the bare base, then again with the solution applied
  (`git apply`, `--3way` as the second try). The task enters only when at least one check fails on the bare base and every check passes with the
  solution. Every other outcome is recorded with its reason (`WarmReason`, `src/rooms/bench/warmup.ts:14`): `base_unreachable`, `solution_commit_not_found`,
  `solution_ambiguous`, `solution_empty`, `solution_too_large`, `clone_failed`, `passes_on_base`, `solution_does_not_apply`, `solution_fails_checks`,
  `host_error`. Dependencies: a copy-on-write copy of `node_modules` on macOS (a symlink that leaves the checkout is refused by Turbopack), a copy on Linux.
- **A host that stops answering** (`src/rooms/bench/build.ts:76-112`): three `host_error` in a row stop that host's chain and the build writes no set (a plugin reload
  mid-build once froze v1 with 5 tasks: every remaining candidate became a host error). Run the build again under a new version.
- **Disk**: a machine with less than 25 GB free (`MIN_FREE_GB`) is not touched: Lane Pilot's own writers hold at min(15 GB, 5%) free, and the bench reserves another 10 GB (`src/rooms/bench/warmup.ts:114-118`)
  (memory `mac-mini-disk-test-temp`).
- **Frozen** (`src/rooms/bench/migrations.ts:14-46`): `lane_pilot_bench_set` and `lane_pilot_bench_task` refuse UPDATE and DELETE by trigger; `manifest_sha256` is the hash of
  the tasks (contract, base commit, solution patch hash; `src/rooms/bench/types.ts:67`) and `runSeries` recomputes it before every run (`src/rooms/bench/store.ts:54`). A different set is a new version.

## A series (`bb lane-pilot bench run`)

### How it works

1. Verify the immutable set, start or resume the run row, then prepare each repository checkout at each task's base commit (`src/rooms/bench/runner.ts:124-149`, `src/rooms/bench/runner.ts:184-194`).
2. Configure the sandbox arm, dispatch tasks, wait for terminal outcomes, gather attempt metrics, and persist results (`src/rooms/bench/runner.ts:160-220`).
3. Stop before another task when the projected token or time budget is reached; record the remaining tasks as skipped and mark the run `stopped_budget`. A host under the free-space floor defers the series (no `stopped_budget` row when nothing was judged) so the next tick can try again (`src/rooms/bench/runner.ts`, `src/rooms/bench/reliability.ts`).

| Series mode or failure | Result |
|---|---|
| Resume same arm and configuration | Keeps finished task rows and continues unfinished tasks (`src/rooms/bench/store.ts:76-91`, `src/rooms/bench/runner.ts:137-143`). |
| Arm config changed under an existing name | Refuses the run and requires a new arm name (`src/rooms/bench/store.ts:76-83`). |
| Missing BB project or checkout failure | Records an error result; project-not-found also stops that repository group (`src/rooms/bench/runner.ts:149-187`). |
| Budget exhausted | Marks remaining tasks `skipped_budget` and run `stopped_budget` (`src/rooms/bench/runner.ts:233-239`). |

`src/rooms/bench/runner.ts:124`. For one arm and repeat, the repositories of the set go side by side, one repository's tasks one after the other:

1. The sandbox project «LP bench <project>» (`defaultProjectName`, `src/rooms/bench/runner.ts:59`; the plugin cannot create a BB project, `bench prepare` prints the
   `bb project create` command) holds a clone; before each task it is reset to that task's `initial_head_sha` (`prepareCheckoutCommand`, `src/rooms/bench/runner.ts:112`).
2. The same contract is dispatched through the normal pipeline (`dispatchWriter`) with `project_cwd` and the checks' folders moved to the clone
   (`benchContract`, `src/rooms/bench/runner.ts:66`). The arm names the writer (`--writer provider/model`, default claude-code/claude-haiku-5-5; the bench PM's compiled main agent accepts only claude-code), the harness tree
   (`--harness none|tree|<tree id>`), its own settings (`--setting key=value`) and, to prove the bench can go red, a fault (`--fault owns|read_first`).
3. **Memory and rules are frozen**: the project is new (no memory, no rules of its own), `memory.enabled|inject|maintain` and the critics are off, and every
   task gets an area of its own (`<area>~b<position><arm>r<n>`), so no area history crosses from one arm to another. The harness tree is the one the arm
   names (`forBenchAttempt`, `src/rooms/harness/server/harness.ts:220`, called from `forAttempt`, `src/rooms/harness/server/harness.ts:195`), never the live alternation.
4. The contract is the stored one with three deterministic touch-ups, the same on every arm: `display_title` and `kind` filled in when the old contract lacks them (today's
   lint refuses it otherwise), and the `read_first` files that are not in the base commit (untracked in the live checkout) dropped (`existingFiles`, `src/rooms/bench/runner.ts:99`). The PM that
   `activate` opens is stopped at once: its prompt tells it to delegate a fixture task of its own.
5. Per task: stages passed, cost, seconds and whether the attempt was accepted, from `lp_attempt_metrics` (`aggregateAttempts`, `src/rooms/bench/runner.ts:83`). Cost
   keeps `cost_state`: a provider that reports no usage is `not_measured`, never 0. The plugin writes a thread's token row minutes after the attempt, so the
   cost is read after a usage sync (`syncTokenUsage`), not before.
6. **Budget** (`bench.budget_tokens`, `bench.budget_hours`; `bench config budget_tokens=N budget_hours=H`; defaults 120 M tokens, 6 h per arm): before each
   task the series stops if what it used plus the average of the finished tasks would pass the cap. The remaining tasks are recorded `skipped_budget`;
   running it again resumes without redoing finished tasks. A task that does not end in 40 minutes is cancelled and counts as not accepted.

## Comparison (`bench compare A B`)

### How it works

1. Pair results by task, calculate pass, stage, cost, and time changes, and apply the default tolerance or the latest noise record (`src/rooms/bench/compare.ts:90-128`).
2. An identical-arm noise comparison records flipped tasks as unstable and measures relative cost/time spread (`src/rooms/bench/compare.ts:65-80`).
3. Return pass or fail; unstable task flips do not fail the comparison (`src/rooms/bench/compare.ts:85-120`).

| Comparison state | Result |
|---|---|
| No paired measured cost | Cost comparison is reported as not measured (`src/rooms/bench/compare.ts:90-110`). |
| Identical-arm flip | Marks the task unstable and excludes it from the failing regression rule (`src/rooms/bench/compare.ts:65-80`, `:103-110`). |

`src/rooms/bench/compare.ts:90`. Paired by task: tasks passed, stages passed, total cost on the tasks where both arms measured it (the rest are listed as not measured),
median time, the list of flips. A task passes on an arm when it was accepted in more than half of that arm's repeats. The change is accepted when stages are
not worse, cost and time are not worse by more than 10%, and no task that passed on A fails on B. It needs at least 80% of the asked tasks paired (and 3), an arm stopped by its
budget is unfinished, and a pass reads «not worse»; it reads «better» only when a task that failed on A passes on B. There is no lower floor for a quick or canary comparison, and no A/A runner yet.

`bench noise X Y` (`computeNoise`, `src/rooms/bench/compare.ts:66`) compares two identical arms: the tasks that flipped become *unstable* (reported, they cannot fail the rule), and the
relative spread of cost and time widens the 10% tolerance. `compare` uses the newest noise record of the set, or `--noise X,Y`.

## Harness adoption (`harness.adopt_by`)

### How it works

1. The configured `adoptBy` value determines whether bench verdicts can adopt harness trees; the default is bench (`src/rooms/harness/server/harness.ts:43`).
2. A comparison with a harness id stores a passed or failed verdict; the harness trial decision reads it to adopt or retire the tested tree (`src/rooms/bench/service.ts:164-173`, `src/rooms/harness/server/harness.ts:499-523`, `src/rooms/harness/server/trial.ts:51-60`).

| State or failure | Result |
|---|---|
| Bench adoption mode with passed verdict | Candidate is adopted (`src/rooms/harness/server/trial.ts:51-60`, `src/rooms/harness/server/harness.ts:506-524`). |
| Failed verdict or insufficient live span | Failed verdict retires the candidate; night editor does not start before minimum attempt and span requirements (`src/rooms/harness/server/trial.ts:51-60`, `src/rooms/harness/server/store.ts:138`). |

`HarnessConfig.adoptBy` (`src/rooms/harness/server/harness.ts:43`, default `bench`; `bb plugin rpc call lane-pilot harness_configure` with `{"patch":{"adoptBy":"live"}}` restores the old
rule). `decideTrial` (`src/rooms/harness/server/trial.ts:51`) with `bench`: the live alternation stays as an observation and can still retire a tree that is worse or unused, but it can
no longer adopt. A tree is adopted when `bench compare <baseline arm> <arm that ran the tree> --harness-id <tree id>` recorded a passed verdict
(`lane_pilot_bench_verdict`, read by `benchInput`, `src/rooms/harness/server/harness.ts:492`), retired when it recorded a failed one. `minSpanDays` (3) joins `minAttempts` (5): the night starts no editor for an area whose
attempts in the window span less than three days (`teachingKeys`, `src/rooms/harness/server/store.ts:138`).

## Running it before the plugin is deployed

`scripts/lp-bench.ts` runs the same code from outside BB: the machines through a shell or ssh, the pipeline through `bb lane-pilot …` and read-only hub queries
(the way `scripts/lp-drill.py` does), the metrics through the real `attemptMetrics` on the run's rows copied from the hub. Until the bench is deployed the deployed
plugin knows only «LP sandbox …» as sandbox traffic, so set `LP_BENCH_LEGACY_SANDBOX=1` and name the projects «LP sandbox bench …». See the header of the script.

## Known limits

- Every bench project is created by hand with `bb project create` (one per repository).
- A series runs one task at a time per repository: tasks have different base commits and share one clone.
- SelfyStudio (73% of the candidates) lives on the OVH machine, whose disk is 98% full; the bench refuses it until 25 GB are free.
- The in-process runner (`src/rooms/bench/server/plugin-ports.ts`) is unit tested through the ports, not run live; the live proof used the external driver.

## Live proof, 2026-10-22 (hub 0.1.263, Mac mini writers, codex/gpt-6-luna)

- Funnel on the hub data: 1114 accepted tasks with `initial_head_sha`; 608 candidates after the pre-filter (SelfyStudio 469, BB-сервис 121, cakekeeper 18; `depends_on` removes 222,
  fewer than two checks 85, a network check 12, a project or folder not allowed 187). The warm-up ran on the Mac mini repositories only (BB-сервис, cakekeeper): 48 tried, 6 survived
  (12.5%): `passes_on_base` 33, `solution_commit_not_found` 4, `solution_too_large` 3, `base_unreachable` 1, `solution_fails_checks`/`solution_does_not_apply` 1 each. Set `v1-local`
  (6 tasks, hash `661f47a0…`) is what that produced. SelfyStudio was not warmed: its repository is on the OVH machine, 98% full (17 GB free, below the 25 GB guard).
- Smoke, three tasks (sheet-link-chips, studio-launcher, 005r), arms `luna-a` and `luna-b` identical, `bad-owns` with `--fault owns`: A 3 of 3 accepted, $0.050, median 178 s; B 3 of 3,
  $0.029, median 105 s; bad-owns 0 of 3, $0.006 measured. Noise of A vs B: no flip, cost spread 50.7%, time 51.6%, stage count differs by 3 (three tasks are too few to calibrate anything).
  `compare luna-a bad-owns` fails (stages 0 vs 13, three tasks passed on A and failed on B), `compare luna-a luna-b` passes.
