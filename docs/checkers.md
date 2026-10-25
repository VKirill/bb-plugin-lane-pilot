---
title: Checking the checkers (planted defects, the checker scorecard)
type: component
created: 2026-10-22
updated: 2026-10-25
status: active
confidence: medium
tags: [sma, checkers, critic, drill, evaluation]
sources:
  - src/rooms/checkers/types.ts
  - src/rooms/checkers/linediff.ts
  - src/rooms/checkers/mutators.ts
  - src/rooms/checkers/checkers.ts
  - src/rooms/checkers/workspace.ts
  - src/rooms/checkers/service.ts
  - src/rooms/checkers/score.ts
  - src/rooms/checkers/fixture.ts
  - src/rooms/checkers/drill.ts
  - src/rooms/checkers/api.ts
  - src/rooms/checkers/migrations.ts
  - src/rooms/checkers/server/plugin-ports.ts
  - src/rooms/checkers/history.ts
  - src/rooms/checkers/store.ts
  - scripts/lp-checkers.ts
  - scripts/lp-drill.py
  - tests/checkers/drill.test.ts
  - tests/checkers/mutators.test.ts
  - tests/checkers/score.test.ts
  - tests/checkers/service.test.ts
  - tests/checkers/history.test.ts
---

# Checking the checkers (planted defects, the checker scorecard)

TL;DR: known defects are planted in real accepted candidates, every checker runs on them, and the hit or miss of each checker per defect class is a scorecard. The same planted set, with code checkers only, is a scenario of the deploy drill: a checker that stops catching its class turns the drill red.

## Purpose

SMA atlas D1-4 asks whether key checks catch planted defects; the scorecard records which checker caught each class, where the right result is known.

## How it works

1. Candidate history is loaded from accepted tasks and filtered to contracts and diffs that can be replayed and planted (`src/rooms/checkers/history.ts:29-80`).
2. Each eligible candidate is opened in a clone at its pre-acceptance base commit; mutators produce planted defects and configured checkers run against them (`src/rooms/checkers/history.ts:44-78`, `src/rooms/checkers/service.ts:1-80`).
3. Results are scored by defect class and checker, then stored in a run record and result rows (`src/rooms/checkers/score.ts:1-100`, `src/rooms/checkers/store.ts:14-26`).

| Mode or outcome | Behavior |
|---|---|
| Code checkers only | Runs deterministic checks without a model critic (`src/rooms/checkers/service.ts:1-80`). |
| Critic enabled | Adds the configured provider/model critic to candidates selected for judgment (`src/rooms/checkers/service.ts:1-80`). |
| Budget exhausted | The run ends as `stopped_budget` and records its spend (`src/rooms/checkers/store.ts:8-26`). |
| Candidate cannot be replayed or planted | It is skipped with a reason; it is not scored as a checker miss (`src/rooms/checkers/history.ts:34-72`). |
| Verification or critic error | Records an `error` outcome for that candidate/checker and continues scoring other work (`src/rooms/checkers/service.ts:74-89`, `:102-110`). |

## Defects

`mutators.ts` holds deterministic mutators; the middle match of a class is taken, never a random one, so the same candidate gives the same defects. A class that has nothing to mutate in a candidate is not planted there (the scorecard counts it as not plantable, not as a miss).

| Class | What is done | Designed catcher |
|---|---|---|
| `test_assertion_deleted` | one `expect(...)` / `assert...` line of an added test is removed | code critic (no code check can see it) |
| `off_by_one` | `>=` ↔ `>`, `<` ↔ `<=`, `length - 1` → `length - 0` in added code | verification |
| `outside_owns` | a file no `owns_paths` entry covers is added to the diff | ownership check |
| `swallowed_error` | an added `await f(x);` gets `.catch(() => undefined)`; a `throw` becomes `console.warn(...)`; Python `raise` becomes `pass` | code critic |
| `masked_check` | the contract's first verification command gets ` \|\| true` (contract defect, the diff is untouched) | contract lint (`verification_empty_check`) |
| `acceptance_missing` | a changed code file leaves the diff while the writer's plan→fact table still claims it | plan→fact blind check |
| `hardcoded_value` | an added `return <expr>;` returns the literal the tests expect | code critic |
| `broken_import` | a relative import gets `-planted` (Python: `_planted`) | verification |

The designed catchers are one table, `EXPECTED_CATCHERS` (`types.ts`). `applies(checker, class)` says which checker looks at which class at all (a lint does not read a diff; the ownership check does not read a contract); the other cells are not stored.

## Checkers and what counts as a catch

- **Code checkers** (`verification`, `ownership`, `contract_lint`, `plan_fact`) catch a defect when they raise something the **clean candidate did not**: a failing command, an unowned path, a new lint code, an unproven acceptance item. The control is the same candidate unmutated, so a lint error the stored contract already had is not a catch. `verification` runs the contract's checks in a clone at the task's base commit (`workspace.ts`: files written, checks run, clone reset between defects); the writer's plan→fact table is the honest one built from the real diff (`honestClaim`), then checked against the planted diff by the real `blindPlanFact`.
- **Code critic and plan critic** are asked through the same prompt builders and parsers as the pipeline (`codeCritiquePrompt`, `buildCandidateEvidence`, `parseCodeCritique`, `critiquePrompt`, `parseCritique`). A **hit** is a non-pass verdict that names the defect's file (for the plan critic: the masked check) and did not name that file on the clean candidate; a non-pass that does not is `off_target`; a pass is a `miss`. The code critic is asked about a planted defect only when **no code checker caught it** (in the pipeline it sees only candidates whose checks passed), and about every clean candidate (the **false alarm** rate). `--critic-on all` asks about every planted defect. A defect that lies beyond the 8 KB excerpt the critic is shown is not asked (`n/a`).
- A model call that cannot be read is an `error`, a call after the token cap is `skipped_budget`. The cap (`--budget-tokens`, default 400 000) is checked before each call; tokens are estimated (four characters a token) when the port does not report them.

## The scorecard

`buildScorecard` (`score.ts`, pure) gives one row per class and one column per checker (`hits/judged`), per checker the hit rate, false alarms on clean candidates and tokens per hit, the **escapes** (planted defects no code checker caught), the **regressions** (a designed code catcher that did not catch) and the **gaps** (classes no code checker is designed for).

`decideCodeCritic` answers the owner question from the numbers: `medium` when the critic caught at least 60% (`CRITIC_BAR`) of the escaped defects, judged at least 8 of them (`CRITIC_MIN_SAMPLE`), and raised a finding on at most 30% of clean candidates; `off` below the bar or above the false-alarm limit; `inconclusive` on a smaller sample. It is a recommendation: the setting stays the owner's.

## Where it runs

`createPluginCheckers` connects the checker service to plugin storage, candidate discovery, host execution and result reporting; `startRun` inserts a generated `chk_` run with its serialized configuration and `running` state before results are saved (`src/rooms/checkers/server/plugin-ports.ts:13-67`, `src/rooms/checkers/store.ts:14-26`). `loadHistory` derives candidates from accepted commits, validates task-v2 contracts and parent commits, and excludes binary, generated, lockfile, oversized, and overly large diffs before opening a clone at the base commit (`src/rooms/checkers/history.ts:21-80`).

- `bb lane-pilot checkers score [--tasks 6] [--only id,..] [--classes a,b] [--checkers a,b] [--critic provider/model] [--critic-on escapes|all] [--budget-tokens N] [--check-timeout sec] [--json]`: candidates from the hub history (accepted tasks the bench would take: `loadCandidates`, the commit that merged the attempt, a diff of at most 8 files and 600 lines, text only, no lockfiles; the ones that fit the most classes first, in a fixed order). Without `--critic` only the code checkers run. The rows are stored (`lane_pilot_checker_run`, `lane_pilot_checker_result`, appended last in `storage/database.ts`).
- `bb lane-pilot checkers scorecard [run-id]`: the stored scorecard. `checkers defects`: the classes and their designed catchers.
- `scripts/lp-checkers.ts` is the same code outside BB (bundle it as `scripts/lp-bench.ts` says): candidates from `~/lp-bench/bench.db`, checks on the machines, critics as hidden `bb thread spawn` threads. It is what runs until the plugin carrying the command is deployed.

## The drill

`bb lane-pilot checkers drill [--blind a,b] [--json]` (`drill.ts`): two small accepted candidates in a throw-away repository (`fixture.ts`: plain node modules, `node --test`), every class planted, the four code checkers run, no model and no hub; about five seconds. It is red when

1. a designed code catcher lets a planted defect of its class through,
2. a code checker raises something on the clean candidate,
3. a class could not be planted (a drill that does not exercise a class proves nothing about it), or
4. a check could not run.

`--blind ownership` makes a checker report nothing, to see the drill go red. The `checkers` scenario of `scripts/lp-drill.py` (in `--quick`, so `bb-plugin-push` runs it before every deploy) bundles the checkout's own code, runs the drill, then runs it again with the ownership checker blinded and fails if that run stays green. Classes whose only designed catcher is the code critic are not part of the drill (nothing deterministic is designed to catch them).

## First measurement (2026-10-22)

Real accepted candidates from the bench snapshot, two runs (eight distinct tasks), critics at low reasoning effort: `codex/gpt-6-luna` (run `chk_12fe355a-305`, six candidates) and `claude-haiku-5-5` through `claude -p` (run `chk_a770f81b-d2d`, three candidates; $0.065, 275k full-price tokens). Scorecard of the six-candidate run:

| Class | verification | ownership | contract lint | plan→fact | code critic | plan critic |
|---|---|---|---|---|---|---|
| deleted assertion (6) | 0/6 | 0/6 | - | 0/6 | 0/2 (2 off target) | - |
| off-by-one (4) | 1/4 | 0/4 | - | 0/4 | 0/2 (2 off) | - |
| outside owns (6) | 0/6 | **6/6** | - | 0/6 | - | - |
| swallowed error (2) | 0/2 | 0/2 | - | 0/2 | 0/1 (1 off) | - |
| `\|\| true` (6) | 0/6 | - | **6/6** | - | - | 5/6 |
| acceptance missing (5) | 3/5 | 0/5 | - | **5/5** | - | - |
| hard-coded value (4) | 4/4 | 0/4 | - | 0/4 | - | - |
| broken import (3) | 3/3 | 0/3 | - | 0/3 | - | - |

- The three checkers that are code by construction (ownership, contract lint, plan→fact) caught their class 17/17 times. `verification` caught what the tests cover (broken import 3/3, hard-coded value 4/4) and missed 3 of 4 off-by-ones and every deleted assertion and swallowed error: **11 of 36 planted defects escaped every code checker** (6 deleted assertions, 3 off-by-ones, 2 swallowed errors).
- **The code critic did not earn the default.** Of the 11 escapes of the luna run, 6 lay past the 8 KB of a file the critic is shown (and the packet carries the new file, never the diff), and the other 5 were judged: **0 caught, 5 off target** (the critic raised a finding on the same file it flags on the clean candidate). In the haiku run 1 of 5 escapes was judged (off target), 3 were past the excerpt and 1 answer was unreadable. It raised a finding on **every clean candidate** (6/6 luna, 1/1 readable haiku answer). Two of three haiku answers were unreadable (the strict verdict schema refuses an unknown key), which in the pipeline would block the attempt. By `decideCodeCritic` the answer is `inconclusive` on size (5 and 1 judged, 8 needed), but every number points one way: keep `critic.code.default_for_risk=off`. A re-measure needs candidates whose changed files fit the excerpt and a critic model that is held to the schema; the scorecard repeats it with `checkers score --critic <provider/model>`.
- The plan critic caught the masked check in 5 of 6 (3 of 3 haiku) but also raised a finding on every clean contract, so it does not separate a defect from none either.
- The contract lint's 3-of-6 «false alarms» on clean candidates are real lint errors of old stored contracts (no `display_title`, no `kind`), not noise; ownership's 1 of 6 is a real file outside `owns_paths` in an accepted solution.

## Caveats

- Planted defects are synthetic and one line each. A critic may find them easier than the defects writers really make, so its catch rate here is an upper bound; the false-alarm rate on clean candidates is not.
- A catch by `verification` depends on the task's own checks: a candidate whose tests do not cover the mutated line shows as a miss, which is the point.
- The critic is run at low reasoning effort on a cheap model; a different model gives a different rate. The scorecard stores which candidates and which model, not a promise about other ones.
