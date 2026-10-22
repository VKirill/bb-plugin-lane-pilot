---
title: Checking the checkers (planted defects, the checker scorecard)
type: component
created: 2026-10-22
updated: 2026-10-22
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
  - src/rooms/checkers/history.ts
  - src/rooms/checkers/fixture.ts
  - src/rooms/checkers/drill.ts
  - src/rooms/checkers/api.ts
  - src/rooms/checkers/store.ts
  - src/rooms/checkers/migrations.ts
  - src/rooms/checkers/server/plugin-ports.ts
  - scripts/lp-checkers.ts
  - scripts/lp-drill.py
  - tests/checkers/drill.test.ts
  - tests/checkers/mutators.test.ts
  - tests/checkers/score.test.ts
  - tests/checkers/service.test.ts
  - tests/checkers/history.test.ts
---

# Checking the checkers

TL;DR: known defects are planted in real accepted candidates, every checker runs on them, and the hit or miss of each checker per defect class is a scorecard. The same planted set, with code checkers only, is a scenario of the deploy drill: a checker that stops catching its class turns the drill red.

## Purpose

SMA atlas D1-4 and the rule «which of your key checks have you seen go red on purpose?» (research note 01, wall 6). Lane Pilot has many checkers (the task's own `verification[]`, the contract lint, the ownership check, the plan→fact blind check, the plan critic, the code critic) and no evidence that any of them catches anything: the statistics in `critique/critic-stats.ts` count real tasks, where the right answer is unknown. A planted defect has a known right answer. It also answers the open owner question: is the code critic worth enabling by default for risk medium and up (`critic.code.default_for_risk`)?

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

## Caveats

- Planted defects are synthetic and one line each. A critic may find them easier than the defects writers really make, so its catch rate here is an upper bound; the false-alarm rate on clean candidates is not.
- A catch by `verification` depends on the task's own checks: a candidate whose tests do not cover the mutated line shows as a miss, which is the point.
- The critic is run at low reasoning effort on a cheap model; a different model gives a different rate. The scorecard stores which candidates and which model, not a promise about other ones.
