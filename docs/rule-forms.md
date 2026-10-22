---
title: Rule forms and the path from a rule to a mechanism
type: component
created: 2026-10-22
updated: 2026-10-22
status: active
confidence: medium
tags: [rules, forms, mechanisms, contract-lint, promotion, sma]
sources:
  - packages/run-insights/src/rule-forms.ts
  - packages/run-insights/tests/rule-forms.test.ts
  - src/rooms/rule-forms/mechanisms.ts
  - src/rooms/rule-forms/promotion.ts
  - src/rooms/rule-forms/jev-forms.ts
  - src/rooms/rule-forms/cli.ts
  - src/rooms/tasks/server/lint-exit-status.ts
  - src/rooms/tasks/server/contract-lint.ts
  - src/rooms/self-repair/server/rule-scan.ts
  - tests/rule-mechanisms.test.ts
  - tests/contract-lint-exit-status.test.ts
  - tests/server/rules-cli.test.ts
  - tests/fixtures/hub-rules-2026-10-22.json
---

# Rule forms and the path from a rule to a mechanism

TL;DR: every rule has a form (`always | skill | check | hook | memory`) set by a deterministic classifier with a recorded reason; a `check` rule that recurs becomes a task contract for a real mechanism (stored, never dispatched or merged by the generator); a rule that a mechanism of this repository fully refuses records that mechanism (`mechanized_by`) and leaves the brief. Maslov (SMA, block 6): «правила, оставшиеся текстом, нарушались; держалось только то, что стало проверкой, воротами или тестом».

## Why

On 2026-10-22 the hub held 167 rules, none with a form: 76 accepted (59 on trial, 15 confirmed), all injected as text. Of the 118 live ones about half are a lint, an ownership check or a test written as a sentence. A sentence is read by an agent that may not apply it; the check refuses.

## The forms and how the classifier decides

`classifyRuleForm(rule)` in `packages/run-insights/src/rule-forms.ts` scores weighted signals over the rule's words; the highest form wins, ties go `check > hook > skill > memory > always`, and below the bar (`FORM_MIN_SCORE`, 3) the rule is **undecided**: it is written as `always` with the reason `undecided: …` (the text stays, as before) and is the only input System One gets.

| Form | Meaning | Signals (examples) |
|---|---|---|
| `check` | A contract lint, ownership check, verification rule or test can refuse the mistake. `mechanism` says which: `contract_lint`, `ownership_check`, `static_test` | names a contract field (`owns_paths`, `expected_outputs`, `verification`), a migration order, a code pattern after «never», `$?`, «the same task must add» |
| `hook` | A guard on a tool call or command (`tool_guard`) | «never run/start/push … `deploy.sh`, `bb thread`, `lane_pilot_*`» |
| `skill` | Procedure or craft a role loads when it does that work | «To ship…», «When deploying…», steps with commands, layout and page craft |
| `memory` | A fact about the project, a machine or the owner | «the owner does not…», «not on the sandbox PATH», product facts |
| `always` | A stance no mechanism can hold | «never end a turn by asking the owner», «take facts from code» |

Every verdict stores `form_reason` (the signals that decided it) and `form_by` (`heuristic | jev | owner | reflection`). The heuristic and Jev never overwrite an owner's or the reflection's form (`setRuleForm`).

Measured on the 118 live hub rules (2026-10-22), against the form a reader chose for each (the fixture `tests/fixtures/hub-rules-2026-10-22.json`): 100 right (85%), 8 undecided. Distribution: check 59, skill 28, always 15 (7 decided, 8 undecided), memory 12, hook 4; of the 76 accepted: check 42, skill 14, always 9, memory 9, hook 2. A test keeps the floor at 80%.

The undecided rest can go to System One (`--jev --host <host-id>`): one choice question per rule (eight per call), a form is taken only at p ≥ 0.5, anything less keeps the rule as text (`jev-forms.ts`).

New rules get a form the night they appear: the `rules-nightly` job runs `classifyUnformed` after the scan.

## Promotion: a recurring `check` rule becomes a mechanism task

`proposePromotions` (`bb lane-pilot rules promote <project> [--repo <path>]`) takes the project's accepted rules of form `check` or `hook` that are not yet held by a mechanism and that recurred (`occurrences ≥ 3`), were decided by the owner, or were confirmed by their trial, and builds a task contract for each (`buildMechanismTask`):

- `owns_paths` in this repository by mechanism kind (a lint in its own file plus `contract-lint.ts`; an ownership check; a guard), `expected_outputs` the test file, `never_touch` the policy files and the architecture tests;
- the objective carries the rule, the recorded failures, and says: write the test first, with a case taken from a recorded failure that the mechanism refuses and a correct case that it allows; `acceptance` and `verification` (`npx vitest run tests/rule-mech-<id>.test.ts` plus the lint's neighbours, focused, never the whole suite) say the same;
- the contract is parsed with `taskV2Schema` and, in the tests, passes Lane Pilot's own contract lint.

The contract is stored in `lane_pilot_rule_promotion` and **nothing is dispatched or merged** (rules are `night_proposes`). `explainChange({kind: "rule_mechanize", files})` classifies it: a mechanism that edits `src/rooms/verification/**` (an ownership check) is `owner_only` by `judge_gates`, stored with state `owner_only` and not offered to the night. One contract per rule, ever: a dismissed one does not come back.

## Mechanisms that exist, and the registry

`src/rooms/rule-forms/mechanisms.ts` lists the rules a mechanism of this repository already refuses, with the test that proves it. Only a `full` entry lets the text leave the brief. `tests/rule-mechanisms.test.ts` runs the **recorded bad case of each full contract-lint entry through the real `lintContract`** (it must be refused with the entry's finding code, and the sound contract must pass) and fails when a named test file is gone, so the registry cannot claim a mechanism that stopped refusing.

Built for this block (new contract lint findings, `src/rooms/tasks/server/lint-exit-status.ts`):

| Finding | Refuses | Rule it replaces |
|---|---|---|
| `verification_masked_exit` | a verification command whose pipeline ends in `tail`, `head`, `tee`, `wc`, … without `pipefail`/`PIPESTATUS` (`npm test \| tail -5` passes when the tests fail) | «Never read `$?` after a pipe …» (accepted, confirmed) |
| `verification_pass_with_no_tests` | `--passWithNoTests` / `--pass-with-no-tests` (a filter with a typo then passes with zero tests) | «… confirm at least one test ran, since --passWithNoTests …» (accepted) |

Already enforced before (now recorded): `filter_folder_slash`, `test_unowned`, `display_title_missing`/`kind_missing`, `ownership_unsafe`/`read_first_path`, and the `ROLE_PROFILES` test that keeps `gitnexus` for the code roles. Partial, shown with their gap and **not** retired: the ownership rules (the attempt gate rejects after the edit; a pre-edit guard does not exist, so the generator proposes one for the owner) and the sandbox-unsafe excludes (only where the project lists them).

## Commands

```
bb lane-pilot rules forms [project] [--form check] [--state accepted|proposed|all] [--json]
bb lane-pilot rules classify [project] [--all] [--jev --host <host-id>] [--dry]
bb lane-pilot rules promote <project> [--repo <path>] [--list] [--json]
bb lane-pilot rules mechanize [project] [--apply]
```

`forms` lists the rules by form with `mechanized_by` (or the classifier's reason); `mechanize` is dry unless `--apply`, records the mechanism and retires the text through the same path as a system retirement (`retireAdoptedRule`: the rule is revoked, its memory record deleted, the event journalled with «mechanized by …»). The Rules tab shows the form as a badge (the reason on hover) and a «enforced by a check» badge with the mechanism on hover.

## Data

Appended migrations (`ruleMechanismMigrations`, last in `migrations`): `lane_pilot_rule_proposal.form_reason`, `form_by`, `mechanized_by`, `mechanized_at`, and the table `lane_pilot_rule_promotion` (`project_id`, `rule_id`, `mechanism`, `state` proposed | owner_only | dispatched | done | dismissed, `task_json`, `tier`, timestamps).

## Not done

The preventive ownership guard (a PreToolUse refusal before the writer edits a path outside `owns_paths`) is the largest cluster of recurring `check` rules (six rules, three of them at 3–4 repeats) and is proposed, not built: it touches the writer spawn and the judge's files. `skill` and `memory` rules still ride in the always-on brief; routing them out is the next step.
