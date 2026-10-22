---
title: Night policy: what the night may decide without the owner
type: component
created: 2026-10-22
updated: 2026-10-22
status: active
confidence: high
tags: [policy, night, exam, owner]
---

# Night policy

SMA block 5 («a clone of the owner's judgment, examined before it may decide») and Maslov's #31448 («graph changes only through your yes»).
The night loop (P1-1) asks one question of every change it wants to make: may I do this alone? This room answers it from a file, and the
answer counts only while an exam over the owner's real past decisions passes.

## Files

| File | What |
|---|---|
| `policy/night-policy.json` | The three lists (`night_decides` line 34, `night_proposes` line 72, `owner_only` line 104), the design items the lists were written from, the split record (line 6) |
| `policy/exam.json` | The held-out exam: 32 items, each with the owner's quote, a change descriptor and the tier his decision implies |
| `policy/exam-result.json` | The last recorded run (`scripts/policy-exam.ts --write`); a test fails when it is stale |
| `src/rooms/policy/policy.ts` | Schema, glob matcher, `explainChange` (line 119), `classifyChange` (line 131) |
| `src/rooms/policy/exam.ts` | `runExam` (line 69), `examFingerprint` (line 65), `authorize` (line 102) |
| `src/rooms/policy/growth.ts` | `ownerOnlyShrank` (line 12), `examShrank` (line 26) |
| `src/rooms/policy/morning.ts` + `scripts/lp-morning.sql` | The three-line morning list |
| `src/rooms/policy/cli.ts` | `bb lane-pilot policy-exam`, `policy show|classify|morning` (registered at `src/rooms/tools/server/cli.ts:94-95`, dispatched at line 109) |

## The change descriptor and the matcher

A caller describes a change as `{kind?, files?, settings?, tables?, attrs?}`. Each policy entry has an id, a description, examples and
`match`: a list of matchers, any of which may fire. A matcher is an AND of the fields it carries (`kinds`, `files_any`, `files_all`,
`settings_any`, `tables_any`, `attrs`), see `matcherMatches` (`policy.ts:105`). Paths are lower-cased, normalised (`docs/../policy/x` is
`policy/x`) and a path that leaves the repository starts with `../` and falls under `owner_only` (`outside_repo`).

Rule (`policy.ts:119-131`): every matching entry is collected, the most restrictive tier wins (`owner_only` > `night_proposes` >
`night_decides`), and a change nothing matches is `night_proposes`. A `night_decides` entry carries its proof as `attrs`
(`bench_subset_passed`, `auto_revertible`, `lost_on_bench`, ...); a missing proof is no match, so the change falls to a proposal.
Consequences that tests pin (`tests/policy/classify.test.ts`): a repair that also touches `src/rooms/verification/**` is the owner's; a
repair that touches `workflows/**` or the workflow engine is only a proposal (#31448); docs regeneration that touches one code file is a
proposal.

## Lists

- `night_decides`: LP-fault repair with the bench subset passing and a one-step revert; docs regeneration (docs files only); memory note
  expiry; retiring a harness tree that lost on the bench; a rule on trial (not always-on); a deploy/release whose full suite and drill are
  green and that rolls back by itself (from `release-workflow` and `owner-no-deploy-confirmations`).
- `night_proposes`: always-on rule; default model / provider / effort / tier / agent for a role; add, remove or reorder a stage; any graph
  edit; core memory edit. They go to the morning list; nothing waits for an answer.
- `owner_only`: spending caps and budgets; secrets and the Env Catalog access model; irreversible data actions; project deletion; the
  judge (gates, bench set, thresholds); this policy, its exam and its classifier; owner login / caller checks / confirmation forms (he
  rejected them on 2026-10-08); any file outside the repository.

## Growth test

`tests/policy/growth.test.ts` reads `git show HEAD:policy/night-policy.json` and fails if an `owner_only` entry disappeared, left the
list, lost or changed a matcher, or if `exam.min_accuracy` fell. A narrowed matcher counts as lost: widen by adding a matcher. The same
test keeps every exam item and its label. With no HEAD version (new file, no git) it skips; the comparison itself is tested on
synthetic before/after pairs.

## The exam

Items are built from the owner's real decisions, kept apart from the items the policy was written from (the `d1..d9` design items inside
the policy file; exam ids are `x1..`). Sources:

| Source | Items | Note |
|---|---|---|
| Rule proposals on the hub (`lane_pilot_rule_proposal`), decisions from 2026-10-15 | 21 | 13 rejected by the owner (`rejectRuleProposal`, `src/rooms/self-repair/server/insights.ts:165`), 2 taken back by him (`revokeRule`), 6 auto-adopted and still standing |
| Memory files the policy was not written from | 11 | owner quotes with the file as reference |
| Learning observations with an owner verdict | 0 | `lane_pilot_learning_obs` has 181 rows, none labelled yet. `bb lane-pilot learning review [n]` and `label <id> ok|wrong` already exist (`src/rooms/learning/ops.ts:61,69`, `cli.ts`); labelled observations become exam items. No second labelling flow was added |

Labelling rubric (in the file): `night_decides` = he said he wants it done without him, or it ran by itself and he left it; `night_proposes` =
he decided that individual change himself (accepted, rejected, took back) or put it through his yes; `owner_only` = he reserved it, or it
touches money, secrets, irreversible data or the judge. Each item has a strength: strong (his words or an action against an agent),
medium (an individual proposal he decided), weak (silence).

`bb lane-pilot policy-exam` runs `classifyChange` over the items, prints accuracy, unsafe answers (softer than the owner wanted), the
confusion matrix, the misses and how many answers came from an entry rather than the default, and stores the result in the plugin
key-value store (`policy:exam-result`). `authorize` (`exam.ts:102`) recomputes the exam on every call: below `min_accuracy` (0.8)
a `night_decides` answer becomes `night_proposes` with the reason. A policy edited without a passing exam therefore cannot decide, and a
stale stored result cannot vouch for a new policy (the fingerprint covers both files).

### First run, 2026-10-22

Accuracy 0.438 (14 of 32), bar 0.8: **failed**, so every `night_decides` answer currently degrades to `night_proposes`. 18 answers were
softer than the owner's decision. Memory items 8/11, rule items 6/21. The failure is almost entirely one entry: the owner rejected 13 and
took back 2 of the 21 rule decisions in the window, while `rule_trial_apply` says the night may put a rule on trial. The three other memory
misses are standing prohibitions (`acp-opencode` back in, Jev routing session turns, fast tier) that the policy has no concept for.
The policy was not tuned on the exam. Moving `rule_trial_apply` to `night_proposes` would score 23/32 = 0.72, still under the bar; the policy
is meant to be re-distilled as the record grows and as the owner labels observations.

## Morning list

Three lines (`composeMorningList`, `morning.ts:15`): decisions waiting for the owner (rule proposals, learning items), what went red in the
last 24 hours, what was accepted. `scripts/lp-morning.sql` is the same list in SQL; `scripts/lp-metrics-daily.sh:28-30` appends it to the
daily Telegram report (the hub copy of `daily.sh` is installed by hand, so `lp-morning.sql` must be copied to
`~/.config/lp-metrics/morning.sql`; without the file the report is unchanged). `tests/policy/morning.test.ts` pins both to the same output.
`bb lane-pilot policy morning` prints it.

## Not wired yet

No night loop exists, so nothing calls `authorize` yet. The P1-1 loop must call it with the descriptor of each change before acting and put
`night_proposes` into the morning list.
