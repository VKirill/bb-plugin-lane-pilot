---
title: Night policy: what the night may decide without the owner
type: component
created: 2026-10-22
updated: 2026-10-22
status: active
confidence: high
tags: [policy, night, exam, owner]
---

> [!important] Since 2026-10-22 the owner takes no part in the loop
> `authorize` reads only the classification and the proofs of its entry. The exam below is a **measurement** of how close the policy is to the owner's own past decisions; it no longer degrades `night_decides`. A `night_proposes` repair is held on its branch and logged; nothing is sent to the owner. `owner_only` means the night never does it.

# Night policy

SMA block 5 («a clone of the owner's judgment, examined before it may decide») and Maslov's #31448 («graph changes only through your yes»).
The night loop (P1-1) asks one question of every change it wants to make: may I do this alone? This room answers it from a file, and the
answer counts only while the policy version has passed an exam over owner decisions made AFTER that version was frozen.

Version 2 (frozen 2026-10-22T11:26:00Z) adds standing prohibitions, moves rules to proposals, and replaces the one-off exam with a growing one.
Today it has no unseen decisions, so **the night decides nothing alone**.

## Files

| File | What |
|---|---|
| `policy/night-policy.json` | Version, `frozen_at`, `frozen_hash`; the lists (`night_decides`, `night_proposes`, `owner_only`), `standing_prohibitions`, the design items the lists were written from, the split record, `versions` |
| `policy/exam.json` | Exam v1: 32 items, history. Version 1 scored 14/32 on it |
| `policy/exam-v2.json` | The committed export of the growing split (owner decisions after the freeze). Empty at the freeze |
| `policy/exam-result.json` | The last recorded run of `scripts/policy-exam.ts --write` on exam v2, plus `history` (the v1 run); a test fails when it is stale |
| `src/rooms/policy/policy.ts` | Schema, glob matcher, `explainChange`, `classifyChange` |
| `src/rooms/policy/exam.ts` | `runExam` (scores any split), `unseenItems`, `runLiveExam`, `authorize`, `policyHash`, `examFingerprint` |
| `src/rooms/policy/live-exam.ts` | The growing split: `collectOwnerDecisions`, `appendLiveItems`, `loadLiveExam`, `recordOwnerDecision`, `collectAndAppend` |
| `src/rooms/policy/growth.ts` | `ownerOnlyShrank`, `examShrank`, `freezeProblems` |
| `src/rooms/policy/cycle.ts` | `shouldStopCycle`: the stop rule of the night loop |
| `src/rooms/policy/morning.ts` + `scripts/lp-morning.sql` | The four-line morning list; the fourth line and the screen «Ждут владельца» are in `docs/owner-waiting.md` |
| `src/rooms/policy/cli.ts` | `bb lane-pilot policy-exam`, `policy show|classify|exam-collect|exam-add|exam-export|morning` (registered in `src/rooms/tools/server/cli.ts`) |

## The change descriptor and the matcher

A caller describes a change as `{kind?, files?, settings?, tables?, attrs?}`. Each policy entry has an id, a description, examples and
`match`: a list of matchers, any of which may fire. A matcher is an AND of the fields it carries (`kinds`, `files_any`, `files_all`,
`settings_any`, `tables_any`, `attrs`), see `matcherMatches`. Paths are lower-cased, normalised (`docs/../policy/x` is `policy/x`) and a path
that leaves the repository starts with `../` and falls under `owner_only` (`outside_repo`).

Rule (`explainChange`): every matching entry is collected, the most restrictive tier wins (`owner_only` > `night_proposes` >
`night_decides`), and a change nothing matches is `night_proposes`. A `night_decides` entry carries its proof as `attrs`
(`bench_subset_passed`, `auto_revertible`, `lost_on_bench`, ...); a missing proof is no match, so the change falls to a proposal.
Consequences that tests pin (`tests/policy/classify.test.ts`): a repair that also touches `src/rooms/verification/**` is the owner's; a
repair that touches `workflows/**` or the workflow engine is only a proposal (#31448); docs regeneration that touches one code file is a
proposal.

## Lists

- `night_decides`: LP-fault repair with the bench subset passing and a one-step revert; docs regeneration (docs files only); memory note
  expiry; retiring a harness tree that lost on the bench; a deploy/release whose full suite and drill are green and that rolls back by
  itself (from `release-workflow` and `owner-no-deploy-confirmations`).
- `night_proposes`: any rule going into force (`rule_trial_apply`, `rule_always_on`); default model / provider / effort / tier / agent for a
  role; add, remove or reorder a stage; any graph edit; core memory edit. They go to the morning list; nothing waits for an answer.
- `owner_only`: spending caps and budgets; secrets and the Env Catalog access model; irreversible data actions; project deletion; the
  judge (gates, bench set, thresholds); this policy, its exam and its classifier; owner login / caller checks / confirmation forms (he
  rejected them on 2026-10-08); any file outside the repository.
- `standing_prohibitions`: see below; all owner_only.

### Standing prohibitions

A `standing_prohibition` is an owner-stated «never do X». It is matched against the change descriptor like any entry, always gives
`owner_only`, and carries `source`: type (`memory_file`, `bb_memory`, `owner_message`), file, line, date, the quote, and `cited_by_v1_exam`.
Sources are design-side material only: the memory directory read as a whole and BB memory, never an exam item. Provenance:

| Id | Source (file:line, date) | Words |
|---|---|---|
| `never_acp_opencode` | `opencode-v2-migration.md:21`, 2026-10-21 | «never reintroduce acp-opencode paths» |
| `never_jev_routes_session_turns` | `lane-markers-plain-sessions.md:13`, 2026-10-13 | «Jev routes ONLY subagents a lane session spawns … never the session's own turns/owner messages» |
| `never_lane_rules_on_plain_sessions` | `lane-markers-plain-sessions.md:15`, 2026-10-13 | «lane rules must never touch sessions unrelated to Lane Pilot» |
| `never_fast_tier_default` | `bb-fast-mode-remembered-default.md:15`, 2026-10-09 | «the owner wants Claude never in fast mode unless he turns it on in that chat» |
| `never_bb_connect_expose` | `bb-no-getbb-vpn-only.md:13`, 2026-10-02 | «never suggest `bb connect expose` or getbb links» |
| `never_flat_access_ban` | `security-keep-legit-paths.md:13`, 2026-10-08 | «never a flat ban» |
| `never_full_suite_per_parallel_agent` | `one-full-suite-per-batch.md:11`, 2026-10-07 | «none of them runs the full test suite» |
| `never_block_env_catalog_reads` | `env-catalog-open-access.md:11`, 2026-10-08 | «don't block `bb env-catalog get/set` in the LP guard/shim/OpenCode lists» |

The first four sources are memory files that v1 exam items also cite (`cited_by_v1_exam: true`); the v1 miss analysis named exactly these
prohibitions. Their text is the owner's standing words and exists independent of the exam, but the corresponding v1 items are now
**in-sample** for version 2 and prove nothing about it. The other four come from files the v1 exam does not cite; they were found by reading
the whole memory directory. A fifth candidate, «do not change the bb-plugin-opencode2 fork», was dropped: its quote is the exam item's quote,
and any file outside the repository is already `owner_only` (`outside_repo`). Access fences and confirmation forms were already covered by
`access_fences` (design item d4).

A prohibition recognises a change by what the caller declares (`descriptor_vocabulary` in the policy file): kinds such as `fast_mode_enable`,
`jev_route_session_turn`, `opencode_v1_enable`, attrs such as `service_tier=fast`, `provider=acp-opencode`. Changes described in other words are
not recognised and fall to the other lists or to `night_proposes`. The night loop must tag changes with this vocabulary. The
vocabulary was invented from the prohibitions, not fitted to exam descriptors; exam items x3, x4 and x6 (the three v1 prohibition misses) are
still misses, because their descriptors use other words.

### Rules moved from the night to the owner

`rule_trial_apply` moved from `night_decides` to `night_proposes` in version 2. The evidence is design-side, not the exam result:

- d10: an accepted rule is `core` subagent memory injected into every writer prompt (`lane-pilot-rules-from-lessons.md:11`), and core memory
  edits were already proposals (`memory_core_edit`). A rule on trial is a core memory edit; version 1 contradicted itself.
- d7: the owner took back the first five trial rules himself in the first week of trials (2026-10-01/03).
- d11: «память единая, на хабе; правила не должны копиться» (owner, 2026-10-03).

Against it: d9 (the SMA analysis, an agent's proposal, listed rules on trial as night-decided), d8 and the fact that a trial can be revoked.
The weighing: revocability makes the change reversible, not unreviewed, and the owner has used the revoke himself. The number of rejections
since 2026-10-15 (13) was not used as a reason; it is what the v1 exam showed, and the v1 exam is seen.

## Freeze and growth tests

`tests/policy/growth.test.ts` reads `git show HEAD:policy/night-policy.json` and fails if an `owner_only` entry or a standing prohibition
disappeared, left the list, lost or changed a matcher, or if `exam.min_accuracy` or `exam.min_items` fell. A narrowed matcher counts as lost:
widen by adding a matcher. It also keeps every item of both exams unchanged (descriptor, expected tier and, for exam v2, `decided_at`). With no
HEAD version (new file, no git) it skips; the comparison itself is tested on synthetic pairs.

A policy version is frozen: `frozen_hash` is the sha256 of the lists (`policyHash`), `frozen_at` the time of the freeze. Edit a list and
`tests/policy/exam.test.ts` fails until you bump `version`, set `frozen_at` to now and write the new hash (`scripts/policy-exam.ts --hash`);
`freezeProblems` refuses a changed list with an old version or an old freeze time, and a moved freeze time with unchanged lists. This is what
keeps an item unseen: it counts for a version only if it was decided after that version's `frozen_at`.

## The exams

An item is built from a real owner decision: his words or the stored record, a change descriptor, and the tier his decision implies.
Labelling rubric: `night_decides` = he said he wants it done without him, or it ran by itself and he left it; `night_proposes` = he decided
that individual change himself (accepted, rejected, took back) or put it through his yes; `owner_only` = he reserved it, or it touches money,
secrets, irreversible data or the judge. Strength: strong (his words or an action against an agent), medium (an individual proposal he
decided), weak (silence).

### Exam v1 (history)

32 items (`policy/exam.json`, ids `x`): 21 rule-proposal decisions from 2026-10-15, 11 from memory files the version-1 policy was not written
from. Version 1 scored **14/32 = 0.438** against the bar 0.8, so night_decides degraded to night_proposes. 18 answers were softer than the
owner's decision. The misses: the policy let the night put rules on trial while the owner rejected 13 and took back 2 of the 21 rule decisions,
and three standing prohibitions it had no concept for. The policy was not tuned on those items. The exam stays immutable; the growth test
enforces it. Every later version has seen it: running version 2 on it gives 23/32 = 0.719 (in-sample, printed by `policy-exam` as a regression
check, not evidence). Six of its nine misses are weak «left standing» items the stricter rule policy now proposes.

### Exam v2 (grows at night)

`policy/exam-v2.json` (committed export) plus the plugin store key `policy:exam-v2` (`loadLiveExam` merges both, deduplicated by id, in
decision order). Item ids are `y_<12 hex of sha256(source type | ref | decision)>`, so collecting twice adds nothing. Each item has
`decided_at`. `collectOwnerDecisions(db, since)` reads the hub tables for decisions after the policy's `frozen_at`:

| Source | Item | Expected | Strength |
|---|---|---|---|
| `lane_pilot_rule_event` owner_accepted / owner_rejected / owner_revoked (the rule text, plus the event detail if any; the rule store keeps no owner note) | `rule_adopt` with `trial` and `always_on` | night_proposes | medium |
| rule adopted by the night, not rejected or revoked for 7 days (`STANDING_DAYS`) | `rule_adopt`, dated when the 7 days end | night_decides | weak (silence) |
| `lane_pilot_learning_obs` with a review label `ok` / `wrong` (not sensitive; masked excerpt) | `learning_item_adopt` | ok: night_decides, wrong: night_proposes | medium |
| an owner message that approves or refuses a change | whatever the caller describes (`recordOwnerDecision`, CLI `policy exam-add`) | as given | strong |

The first three are automatic: `bb lane-pilot policy exam-collect` (`collectAndAppend`) is the night step, idempotent, append-only. Owner
messages need a reader: nothing in the hub classifies a free message into a change descriptor, so whoever reads one (the night loop, a PM) calls
`exam-add`. That part is not automatic yet. The store refuses to grow past 200 KB (BB's plugin store value limit is 256 KB): export it with
`policy exam-export` into `policy/exam-v2.json` and commit.

`runLiveExam` scores the current policy on the newest unseen split: `unseenItems` keeps items with `decided_at` strictly after `frozen_at`.
`bb lane-pilot policy-exam` prints the result (`passed` only with enough items AND accuracy at the bar), the one-line verdict, and the v1
in-sample figure. Exit code 0 passed, 1 failed, 2 not enough unseen decisions yet.

`authorize(change, {exam})` (`exam.ts`): the classification is final except for night_decides, which stands only when `runLiveExam` passes:
at least `exam.min_items` (20) unseen items and `exam.min_accuracy` (0.8) on them. Otherwise it is `night_proposes` with the reason (`NOT
ENOUGH UNSEEN DECISIONS YET: n of 20 …` or `FAILED: …`). It recomputes on every call. The night loop must pass the merged split
(`loadLiveExam(kv)`); with no `exam` option it reads only the committed file. `policy classify` does the former.

### Current state, 2026-10-22

Version 2 frozen at 2026-10-22T11:26:00Z. Exam v2 holds 0 items. Not enough unseen decisions yet; night decides nothing alone. The first
decisions will come from rule proposals the owner accepts or rejects, labels set with `bb lane-pilot learning review` / `label <id> ok|wrong`, and
`exam-add`. 20 are needed. If the policy is edited before then, it is a new version with a new freeze and the decisions already collected become
seen.

## Stop rule for the night loop

`shouldStopCycle(history, {epsilon?, patience?})` (`cycle.ts`): RHI (arXiv 2607.15524) stops when the win rate falls under a threshold; the SMA
gap analysis section 4.1 turns this into a limit on the night loop's rounds: stop when the bench shows no improvement two cycles in a row.
`history` is the bench score after each cycle, oldest first, the first entry being the incumbent before any cycle. A cycle improves when it beats
the best score so far (not the previous cycle) by more than `epsilon` (default 0). It stops when the last `patience` (default 2) cycles did not.
Fewer than `patience` + 1 entries never stop. Nothing calls it yet (no night loop).

## Morning list

Three lines (`composeMorningList`): decisions waiting for the owner (rule proposals, learning items), what went red in the
last 24 hours, what was accepted. `scripts/lp-morning.sql` is the same list in SQL; `scripts/lp-metrics-daily.sh` appends it to the
daily Telegram report (the hub copy of `daily.sh` is installed by hand, so `lp-morning.sql` must be copied to
`~/.config/lp-metrics/morning.sql`; without the file the report is unchanged). `tests/policy/morning.test.ts` pins both to the same output.
`bb lane-pilot policy morning` prints it.

## Not wired yet

No night loop exists, so nothing calls `authorize`, `collectAndAppend` or `shouldStopCycle` yet. The P1-1 loop must: tag each change with the
descriptor vocabulary, call `authorize(change, {exam: await loadLiveExam(kv)})` before acting, put `night_proposes` into the morning list, run
`collectAndAppend` once a night, and call `shouldStopCycle` after each cycle.
