---
title: Self-improvement
topic: self-improvement
type: overview
status: active
created: 2026-11-06
confidence: medium
tags: [guide, self-improvement]
updated: 2026-11-06
sources:
  - src/rooms/errands/episode-enrich.ts
  - src/rooms/night-graphs/server/episodes-graph.ts
  - src/rooms/wall/server/index.ts
  - src/rooms/lead/server/index.ts
---

# Self-improvement

> Part of the [Lane Pilot guide](../../README.md#the-guide). Moved out of the root README on 2026-11-06.

Lane Pilot learns from its own failures and from the owner's messages, and tests every change against evidence before it keeps it. The whole flow has one screen, System, Self-improvement, which saves global settings with `save_setting` (`wall.*`, `bench.*`, `harness.*`, `owner_push.*`, `baseline.*`, `regress.*`, `plan_fact.mode`, `critic.code.default_for_risk`, `memory.note_budget`). Long jobs stay commands.

| Job | When | What it does |
|---|---|---|
| `wall-night` | 03:00 | Groups failures into classes, queues repairs |
| `wall-advance` | :05 :20 :35 :50 | Verdicts, merges, acceptance, task walls |
| `bench-nightly` | 01:30 | Runs every active bench set as the night arm |
| `bench-weekly` | Sunday 02:00 | Weekly compare and the sealed holdout probe |
| `regress-nightly` | 03:25 | Re-checks recent accepted tasks on main |
| `rules-nightly` | 03:30 | Rule scan, then classifies new rules by form |
| `harness-nightly` | 04:10 | Judges trials, starts writer-harness editors |
| `critic-edit-monthly` | 05:20, day 1 | Critic calibration and prompt proposal |
| `learning-extract`, `learning-digest` | 03:11, 18:20 | Owner-message learning (the night batch, the day's report) |

## Crystallization: repeated work becomes a rule, skill, script or graph

The direction since 2026-11-06: work climbs from free agent work to a skill, a graph, a fixed step and finally a script, each move made on evidence. Stage 1 gives that evidence.

- **Episodes.** Every finished errand leaves one row (`lane_pilot_errand_episode`), failed ones too. Facts are written at completion; a `CHECK:` line in the helper's answer gives a verified outcome. Every hour the graph `lp.episodes` takes up to 10 pending episodes, masks secrets and personal data in the helper's thread, and has the `episode-analyst` role (Gemini 3.8 Flash through 9router by default) write the card: goal, parameters, what helped, where it stumbled, failure class, and a proposed process key. Three model calls run at once (`EPISODE_SWEEP_PARALLEL`); the key is chosen one at a time, by Jev's `errand.process_key` among the 8 nearest known keys, so two runs of one process in one batch get one key. The analyst runs in an empty folder (`~/.lane-pilot/episode-analyst`) and is told to call no tools, so it cannot read other threads from disk. `bb lane-pilot errands episodes-backfill` fills rows for past errands; `errands episodes-sweep` runs a pass now; `errands process-key-eval` scores the keys against a hand-labelled gold set.
- **Diagnosis.** `bb lane-pilot errands diagnose [--days 30]` shows errands by kind, their cost and the groups that repeat (on 2026-11-06: 132 errands, $302 in 30 days, 6 repeat groups).
- **Five forms.** The lead proposes a repeated process as one of five forms: a rule, a note, a script, a skill or a graph (`docs/lead.md`). A skill comes before a graph unless the work needs a gate, a timetable or helpers of different kinds. New skills follow [the skill standard](../skill-standard.md); `bb lane-pilot skill-lint <dir>` checks one.

## The nightly loop (wall)

A class is `failure class : hash of the normalised reason`. Each class follows a recurrence ladder: rung 3 means it is within 3 of the last 10, 5 of 100 and 6 of 500 finished real attempts. Sandbox, bench and drill traffic stay out. A night picks at most three classes, each on Lane Pilot's side or recurring three times in seven days, and queues a repair for the self-repair watcher (a regression test that fails without the change, a whole-repository search for other sites, `NIGHT-REPORT` at the end). The night policy decides whether the repair may merge alone. After the merge the loop watches the deploy: the drill of the shipped version must be green, the canary quiet, the bench subset not worse, and the class must stop recurring; otherwise the merge is reverted in code. Two normal moves, then three read-only hunters on another model (their citations are checked by code), then one informed move, then the backlog with a full analysis. Failed attempts of a repaired class are re-run on the new head in sandbox and bench projects only; real projects are listed. `bb lane-pilot wall status|night [--dry-run]|advance|show|close|rerun|config|morning`.

| Setting | Default |
|---|---|
| `wall.enabled` | `true` |
| `wall.max_classes_per_night` / `wall.rounds_per_night` | `3` / `2` |
| `wall.walks` / `wall.hunters` | `2` / `3` |
| `wall.night_token_cap` / `wall.hunt_share_percent` | `20000000` / `25` |
| `wall.assumed_repair_tokens` | `4000000` |
| `wall.hunter_provider` / `wall.hunter_model` / `wall.hunter_reasoning_effort` | `codex` / `gpt-6.1-sol` / `medium` |
| `wall.bench_subset` / `wall.recurrence_floor` / `wall.rerun_sandbox_only` | `8` / `3` / `true` |

## LP-Bench

A fixed set of real past tasks, replayed on an arm (writer, harness tree, settings) and compared in pairs. Code decides everything: a task passes when its `verification[]` passed and the gates accepted the attempt.

- **Sets.** Built from accepted tasks with at least two checks, no `depends_on`, no secrets or network, in allowed projects. Each task is warmed up: some check fails on the bare base and every check passes with the accepted solution applied. A set is immutable (triggers refuse UPDATE and DELETE; the manifest hash is re-checked before each run). Memory and rules are off for the replay.
- **Strata.** `selfystudio-page`, `selfystudio-feature`, `selfystudio-other`, `bb-service`, `cakekeeper`, plus `fresh`, `small`, `long`, `noncode` and `sealed`. At least 30 % of each stratum is "hard" (not accepted on attempt 1).
- **Noise.** `bench noise A B` compares two identical arms; flipped tasks become unstable and cannot fail a comparison, and the measured spread widens the 10 % cost and time tolerance. A comparison passes when stages are not worse, cost and time are within tolerance and no task that passed on A fails on B. Cost keeps `not_measured`, never 0.
- **Sealed weekly set.** On Sunday a `sealed-week-*` holdout is built from candidates the open strata skipped and run with the week's arm. If its pass share trails the open set by more than `bench.sealed_gap_pp` (15), the loop flags possible overfit and holds new fixes.
- **Critic bench.** Two bundled advisory sets of PR-shaped tasks (`bench/known-bugs-v1.json`, 20 buggy patches with expected findings; `bench/real-prs-v1.json`, 15 real PRs with outcomes) score the code critic: bad PRs caught, false alarms on clean PRs.
- Commands: `bb lane-pilot bench build|show|prepare|run|noise|compare|status|sweep|config|baseline|gate`. `bench baseline` needs no model (false-done rate, phantom writes, git loss recoverability).

| Setting | Default |
|---|---|
| `bench.budget_tokens` / `bench.budget_hours` | `120000000` / `6` per arm |
| `bench.nightly_sets` | `all` |
| `bench.nightly`, `bench.weekly` | on (read from global settings, not in the catalog) |
| `bench.sealed_gap_pp` | `15` (not in the catalog) |

## Rules from lessons

Failures and owner messages become rule proposals. `collectLessonSources` reads night-review findings, rejected stage receipts and failed attempts (drill tasks and noise reasons excluded); a lesson that repeats within 30 days becomes a proposal. A rule the system adopts goes on trial: confirmed after 5 attempts without a recurrence, rewritten after 2 recurrences, rewritten at most twice, then retired if it keeps recurring, and retired after 60 days of not being needed; at most 12 system rules per project. The owner can accept, reject or revoke any rule in Knowledge, Rules; owner decisions are never touched by the trial. A scan can also ask the project's rules analyzer to read recent failures.

Every rule gets a form with a recorded reason, from a deterministic classifier (85 % right on the hub's 118 rules at 2026-10-22, below the bar a rule is `undecided` and stays `always`):

| Form | Meaning |
|---|---|
| `check` | A contract lint, ownership check or test can refuse the mistake |
| `hook` | A guard on a tool call |
| `skill` | A procedure a role loads when it does that work |
| `memory` | A fact about the project, a machine or the owner |
| `always` | A stance no mechanism can hold |

A recurring `check` or `hook` rule can be promoted: `rules promote` stores a task contract for a mechanism (never dispatched or merged by the generator; a mechanism that touches the judge is `owner_only`). A rule that a mechanism fully refuses records it (`mechanized_by`) and leaves the brief: `rules mechanize [--apply]`. Commands: `bb lane-pilot rules forms|classify|promote|mechanize`.

## Learning from the owner's messages

Owner messages in visible top-level threads are filtered by rule (machine text, acknowledgements and pasted logs are dropped, personal data is masked) and kept as candidates; one night run (03:11) reads the day's candidates in batches with the rules analyzer model and extracts a rule on trial, a preference, a decision note, a reminder or a recorded fact, deduplicating against what is in force in the same pass. No Jev and no outside classifier is involved. Settings live in the `learning:config` store (`bb lane-pilot learning config key=value`): `dailyCandidateCap` `400`, `nightRuns` `12`, `nightBatch` `25`, `pmRulesTokens` and `writerRulesTokens` `1600`. A message that matches sensitive words is never sent and keeps no text.

## The writer harness and the critic edit

The harness adds a tree per (project, area, writer model) on top of the fixed brief: always-on text, skills, checks, hooks and memory. At night an editor reads recent attempts and trajectories and proposes a candidate tree (two editors and a composer; a replay probe, default 24000 tokens, checks it). The candidate runs on trial in alternation with the active tree, then a reflection writes per-edit verdicts and at most one lesson, which enters the rules pipeline. `harness.adopt_by` defaults to `bench`: a tree is adopted only after `bench compare ... --harness-id` records a passed verdict; `live` restores adoption by live alternation. Defaults: enabled, 5 attempts over 7 days spanning at least 3 days, 2 keys per night, a trial decides at 6 attempts per arm (3 after 14 days) and adopts when acceptance is within 5 points and blocking findings and retries do not rise. Editing workflow JSON is off. CLI: `bb lane-pilot harness|harness-edit|harness-tick|harness-trajectory`. `lp.critic-edit` runs monthly: when a critic's verdict matched the outcome less than half the time over four or more verdicts, it stores a prompt proposal; the same bench gate and 14-day deadline apply and no prompt changes without a passed verdict (trial flag `lp.critic.edit.trial`, on by default).

## The Self-improvement page

| Section | Controls | Read-only |
|---|---|---|
| Night loop | `wall.*` | A dry run of the night |
| Bench set | `bench.budget_tokens`, `bench.budget_hours`, `harness.adopt_by` | Newest set: tasks, candidates, date |
| Night policy | none, on purpose (it is the judge) | Version, freeze date, exam progress, lists |
| Checks | `baseline.*`, `checks.require_red_on_base`, `plan_fact.mode`, `critic.code.default_for_risk`, `regress.*` | Defaults for all projects |
| Waiting for the owner | `owner_push.*` | Deferral counts |
| Memory | `memory.note_budget` | Pointer to Knowledge, Memory |

A status strip shows the last and next night, the newest bench set size, the policy exam progress and the count of what waits for the owner. Each control writes the global level with the setting's version; a CLI write moves the version, so an open page reloads on its next save.

## Hypotheses, coverage and the checkers

- `bb lane-pilot hypothesis add|test|verdict|revert|list`: an idea written as settings, tested on the bench (arms `hyp-<id>-base` and `hyp-<id>`); not worse goes to the night policy as a `setting_change`. Seeded: `role-contracts` (`writer.brief_mode=narrow`).
- `bb lane-pilot coverage`: for every stage, transition, failure class, gate, memory path, room and mechanism, the drill scenario that runs it or the reason none does; a test fails when a node has no entry.
- `bb lane-pilot checkers`: plants known defects in accepted candidates and scores each checker per defect class; a code-only version is a drill scenario.
- Baseline and regression: a task's checks run once on its base before the writer (`baseline.already_built` `notify`, `baseline.time_cap_sec` `300`, `checks.require_red_on_base` `medium`); `regress.nightly` (`true`, last `30` tasks within `14` days) re-runs accepted checks on main and bisects red ones.
- `scripts/lp-design-eval.ts <url>` scores a page by code at 375 and 1280 px (overflow, contrast, targets, tiny text, one H1, spacing).

## SMA map, research adoption, night policy

- `bb lane-pilot sma-map [--status ...] [--check-proofs] [--live [--days N]]` lists the SMA product map node by node with the proof link and the contract tests that check each card. The static entries hold 1798 nodes. A node with a failing behaviour test (`it.todo`) shows as partial, so a proof link alone does not count as checked.
- `docs/research-adoption.md` logs which external ideas were adopted and which rejected, one line each with the reason. `docs/sma-self-check.md` records a 20/20 self-assessment (Russian).
- Night policy (`policy/night-policy.json`, frozen with a hash): every change gets a tier, `night_decides` (LP-fault repair with bench proof and a one-step revert, docs regeneration, memory expiry, retiring a losing harness tree), `night_proposes` (rules, default models, stage or graph edits, core memory edits) or `owner_only` (budgets, secrets, the judge, standing prohibitions, anything outside the repository). The most restrictive match wins. The exam (`bb lane-pilot policy-exam`, exit 0 passed, 1 failed, 2 too few items) scores the policy on owner decisions made after its freeze; it needs 20 unseen items at 0.8; it is a measurement, not a gate. `shouldStopCycle` ends the night series after two cycles without a bench gain.

## Anamnesis

Anamnesis is the owner profile. `bb lane-pilot anamnesis status|list|show|history|add|edit|confirm|reject|forget|sources|host` works on records with evidence and a sensitivity class. Collectors read git history, journals, the project registry, Claude and BB memory, and, only when the owner switches them on, selected Telegram channels and Elba deal files. Detected personal data (e-mail, IBAN, card, phone, account and identity numbers, addresses) is masked, and sensitive records are hidden from reviews and shown only on explicit request.

## Forecast and plan against fact

The PM may put a `forecast` (files, first-try checks, tokens, minutes) in the task contract; the writer never sees it. After acceptance `bb lane-pilot forecast [--project P] [--days 30]` compares it with the facts per area, and the PM reads one calibration line once three tasks are scored. `plan_fact.mode` (`record` default, `gate`) checks the writer's acceptance table against the diff and check results in code.

## Measurements that are off by default

Three further measurements feed the morning summary: the diff-hidden audit of the checkers (`checkers.diff_hidden_limit`), the skill-switch metric and the nightly PM `context.md` (`pm.context_file`). Each is described, with how to turn it on, under [Experimental features](settings.md#experimental-features).

## Sources

Where this page's claims start in the code: `src/rooms/errands/episode-enrich.ts:25-45`, `src/rooms/night-graphs/server/episodes-graph.ts:15-35`, `src/rooms/wall/server/index.ts:1-6`, `src/rooms/lead/server/index.ts:1-7`. The deep pages linked above cite the rest.
