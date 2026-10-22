---
title: LP-Bench, the fixed task set
type: component
created: 2026-10-22
updated: 2026-10-22
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
---

# LP-Bench, the fixed task set

Matvey Maslov's rule (#31448): twenty to fifty real tasks from past runs whose right result is known; the same graph run again with another
model or another edit; three numbers: how many stages passed, what it cost, how long it took; the set is not changed. This is that set
(SMA plan P0-1). Code decides everything: a task passes when its `verification[]` passed and the gates accepted the attempt; no model judges.

## The set

- **Selection** (`candidates.ts:47`): the accepted tasks with `initial_head_sha`, their first accepted attempt (`hard` when it is not
  attempt 1), in the projects the owner allows (`types.ts:9`: SelfyStudio, BB-сервис plugins, cakekeeper; no client or IP folders). A
  contract is refused with a reason (`candidates.ts:18`): fewer than two checks, `depends_on`, secrets, a check that needs the network or a login
  (curl, ssh, docker, `npm install`, playwright …), an empty check (`emptyCheckReason` of the contract lint), drill tasks, sandbox projects
  (`isSandboxProjectName`).
- **Strata** (`stratify.ts:10`): 10 SelfyStudio pages, 8 features, 2 other, 6 BB-сервис, 4 cakekeeper. At least 30% of each stratum is «hard»
  (`chooseFinal`, `stratify.ts:47`) and the risks rotate low, medium, high. Candidates are tried hard and easy interleaved (`warmOrder`, 4 hard in 10).
  A hash of the seed, not a random number, orders them: the same build picks the same tasks.
- **Warm-up** (`warmup.ts:67`): the solution is the merge commit of the accepted attempt (found by its `Lane-Pilot-Attempt:` trailer, else by the
  `<task id>: ` subject). In a fresh clone at `initial_head_sha` the contract's checks run on the bare base, then again with the solution applied
  (`git apply`, `--3way` as the second try). The task enters only when at least one check fails on the bare base and every check passes with the
  solution. Every other outcome is recorded with its reason (`WarmReason`, `warmup.ts:14`): `base_unreachable`, `solution_commit_not_found`,
  `solution_ambiguous`, `solution_empty`, `solution_too_large`, `clone_failed`, `passes_on_base`, `solution_does_not_apply`, `solution_fails_checks`,
  `host_error`. Dependencies: a copy-on-write copy of `node_modules` on macOS (a symlink that leaves the checkout is refused by Turbopack), a copy on Linux.
- **A host that stops answering** (`build.ts`): three `host_error` in a row stop that host's chain and the build writes no set (a plugin reload
  mid-build once froze v1 with 5 tasks: every remaining candidate became a host error). Run the build again under a new version.
- **Disk**: a machine with less than 25 GB free (`MIN_FREE_GB`, `warmup.ts:112`) is not touched: Lane Pilot's own writers hold at min(15 GB, 5%)
  (memory `mac-mini-disk-test-temp`).
- **Frozen** (`migrations.ts`): `lane_pilot_bench_set` and `lane_pilot_bench_task` refuse UPDATE and DELETE by trigger; `manifest_sha256` is the hash of
  the tasks (contract, base commit, solution patch hash; `types.ts:67`) and `runSeries` recomputes it before every run (`store.ts:54`). A different set is a new version.

## A series (`bb lane-pilot bench run`)

`runner.ts:124`. For one arm and repeat, the repositories of the set go side by side, one repository's tasks one after the other:

1. The sandbox project «LP bench <project>» (`defaultProjectName`, `runner.ts:59`; the plugin cannot create a BB project, `bench prepare` prints the
   `bb project create` command) holds a clone; before each task it is reset to that task's `initial_head_sha` (`prepareCheckoutCommand`, `runner.ts:112`).
2. The same contract is dispatched through the normal pipeline (`dispatchWriter`) with `project_cwd` and the checks' folders moved to the clone
   (`benchContract`, `runner.ts:66`). The arm names the writer (`--writer provider/model`, default codex/gpt-6-luna), the harness tree
   (`--harness none|tree|<tree id>`), its own settings (`--setting key=value`) and, to prove the bench can go red, a fault (`--fault owns|read_first`).
3. **Memory and rules are frozen**: the project is new (no memory, no rules of its own), `memory.enabled|inject|maintain` and the critics are off, and every
   task gets an area of its own (`<area>~b<position><arm>r<n>`), so no area history crosses from one arm to another. The harness tree is the one the arm
   names (`forBenchAttempt`, `harness.ts:220`, called from `forAttempt`, `harness.ts:195`), never the live alternation.
4. The contract is the stored one with three deterministic touch-ups, the same on every arm: `display_title` and `kind` filled in when the old contract lacks them (today's
   lint refuses it otherwise), and the `read_first` files that are not in the base commit (untracked in the live checkout) dropped (`existingFiles`, `runner.ts:99`). The PM that
   `activate` opens is stopped at once: its prompt tells it to delegate a fixture task of its own.
5. Per task: stages passed, cost, seconds and whether the attempt was accepted, from `lp_attempt_metrics` (`aggregateAttempts`, `runner.ts:83`). Cost
   keeps `cost_state`: a provider that reports no usage is `not_measured`, never 0. The plugin writes a thread's token row minutes after the attempt, so the
   cost is read after a usage sync (`syncTokenUsage`), not before.
6. **Budget** (`bench.budget_tokens`, `bench.budget_hours`; `bench config budget_tokens=N budget_hours=H`; defaults 120 M tokens, 6 h per arm): before each
   task the series stops if what it used plus the average of the finished tasks would pass the cap. The remaining tasks are recorded `skipped_budget`;
   running it again resumes without redoing finished tasks. A task that does not end in 40 minutes is cancelled and counts as not accepted.

## Comparison (`bench compare A B`)

`compare.ts:90`. Paired by task: tasks passed, stages passed, total cost on the tasks where both arms measured it (the rest are listed as not measured),
median time, the list of flips. A task passes on an arm when it was accepted in more than half of that arm's repeats. The change is accepted when stages are
not worse, cost and time are not worse by more than 10%, and no task that passed on A fails on B.

`bench noise X Y` (`computeNoise`, `compare.ts:66`) compares two identical arms: the tasks that flipped become *unstable* (reported, they cannot fail the rule), and the
relative spread of cost and time widens the 10% tolerance. `compare` uses the newest noise record of the set, or `--noise X,Y`.

## Harness adoption (`harness.adopt_by`)

`HarnessConfig.adoptBy` (`harness.ts:43`, default `bench`; `bb plugin rpc call lane-pilot harness_configure` with `{"patch":{"adoptBy":"live"}}` restores the old
rule). `decideTrial` (`trial.ts:51`) with `bench`: the live alternation stays as an observation and can still retire a tree that is worse or unused, but it can
no longer adopt. A tree is adopted when `bench compare <baseline arm> <arm that ran the tree> --harness-id <tree id>` recorded a passed verdict
(`lane_pilot_bench_verdict`, read by `benchInput`, `harness.ts:492`), retired when it recorded a failed one. `minSpanDays` (3) joins `minAttempts` (5): the night starts no editor for an area whose
attempts in the window span less than three days (`teachingKeys`, `src/rooms/harness/server/store.ts:138`).

## Running it before the plugin is deployed

`scripts/lp-bench.ts` runs the same code from outside BB: the machines through a shell or ssh, the pipeline through `bb lane-pilot …` and read-only hub queries
(the way `scripts/lp-drill.py` does), the metrics through the real `attemptMetrics` on the run's rows copied from the hub. Until the bench is deployed the deployed
plugin knows only «LP sandbox …» as sandbox traffic, so set `LP_BENCH_LEGACY_SANDBOX=1` and name the projects «LP sandbox bench …». See the header of the script.

## Known limits

- Every bench project is created by hand with `bb project create` (one per repository).
- A series runs one task at a time per repository: tasks have different base commits and share one clone.
- SelfyStudio (73% of the candidates) lives on the OVH machine, whose disk is 98% full; the bench refuses it until 25 GB are free.
- The in-process runner (`server/plugin-ports.ts`) is unit tested through the ports, not run live; the live proof used the external driver.

## Live proof, 2026-10-22 (hub 0.1.263, Mac mini writers, codex/gpt-6-luna)

- Funnel on the hub data: 1114 accepted tasks with `initial_head_sha`; 608 candidates after the pre-filter (SelfyStudio 469, BB-сервис 121, cakekeeper 18; `depends_on` removes 222,
  fewer than two checks 85, a network check 12, a project or folder not allowed 187). The warm-up ran on the Mac mini repositories only (BB-сервис, cakekeeper): 48 tried, 6 survived
  (12.5%): `passes_on_base` 33, `solution_commit_not_found` 4, `solution_too_large` 3, `base_unreachable` 1, `solution_fails_checks`/`solution_does_not_apply` 1 each. Set `v1-local`
  (6 tasks, hash `661f47a0…`) is what that produced. SelfyStudio was not warmed: its repository is on the OVH machine, 98% full (17 GB free, below the 25 GB guard).
- Smoke, three tasks (sheet-link-chips, studio-launcher, 005r), arms `luna-a` and `luna-b` identical, `bad-owns` with `--fault owns`: A 3 of 3 accepted, $0.050, median 178 s; B 3 of 3,
  $0.029, median 105 s; bad-owns 0 of 3, $0.006 measured. Noise of A vs B: no flip, cost spread 50.7%, time 51.6%, stage count differs by 3 (three tasks are too few to calibrate anything).
  `compare luna-a bad-owns` fails (stages 0 vs 13, three tasks passed on A and failed on B), `compare luna-a luna-b` passes.
