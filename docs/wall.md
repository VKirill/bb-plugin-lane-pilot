---
title: The wall journal and the night loop
type: component
created: 2026-10-22
updated: 2026-10-22
status: active
confidence: medium
tags: [night, wall, journal, self-repair, loop-guard, rerun, sma]
sources:
  - src/rooms/wall/types.ts
  - src/rooms/wall/config.ts
  - src/rooms/wall/migrations.ts
  - src/rooms/wall/signature.ts
  - src/rooms/wall/logs.ts
  - src/rooms/wall/journal.ts
  - src/rooms/wall/select.ts
  - src/rooms/wall/ladder.ts
  - src/rooms/wall/pack.ts
  - src/rooms/wall/brief.ts
  - src/rooms/wall/acceptance.ts
  - src/rooms/wall/rerun.ts
  - src/rooms/wall/morning.ts
  - src/rooms/wall/store.ts
  - src/rooms/wall/service.ts
  - src/rooms/wall/server/wall.ts
  - src/rooms/self-repair/server/hooks.ts
  - src/rooms/self-repair/server/self-repair.ts
  - packages/contracts/src/stage-inputs.ts
  - scripts/lp-wall-morning.sql
  - scripts/wall-retro.ts
  - tests/wall/service.test.ts
---

> [!important] Since 2026-10-22 the owner takes no part in the loop
> A repair with its proofs merges (`authorize` has no exam gate), the checks after the merge revert it; a held repair and a wall in the backlog are logged, not posted to «Waiting for the owner». The backlog entry of the deferral register gets the default term of 14 days.

# The wall journal and the night loop

TL;DR: every night at 03:00 Lane Pilot groups the last 24 hours of failures into classes, follows each class on the 3/10, 5/100, 6/500 recurrence
ladder, sends at most three classes to the self-repair path with the proof, the whole-class sweep and a cap, merges a repair only when the night
policy allows it, checks it after the release train shipped it, and never retries a wall forever: two moves, then the hunt, then one informed move,
then the backlog.

Sources: Maslov #31448 («чинит не случай, а класс … гоняешь, пока условно не будет 3/10, 5/100, 6/500»; 1-3 recommendations a cycle, each with
its proof, a limit of rounds and budget) and the dialogue of 2026-10-22 («3 ходки … меняется перспектива … беклог»; «меняет голову и гонит на
новой голове начиная со 2, пропускает 4-5»); atlas delta D0-1, D0-2 (as far as the re-run needs it), D1-1.

## The journal and the classes

A *class* is `failure class : hash of the normalised reason` (`signature.ts`): ids, hashes, numbers and paths are blanked, a red check is one class
whatever its command, and a rejected path list keeps only the kinds of files (`<paths:test>`, `<paths:locale>`, `<paths:lockfile>`, `<paths:src>`),
because stray tests, a shared locale file and a lockfile are different problems. The LP version and the project are dimensions of the journal, not
of the class.

| Table | What |
|---|---|
| `lane_pilot_wall_entry` | the journal: one row per night x class x LP version x project: failures, tasks, the sources that saw it (attempt, triage, gate event, stage receipt, plugin log), the gates and stages it broke in, sample attempts |
| `lane_pilot_wall_class` | one row per class: failures among the last 10 / 100 / 500 finished real attempts, rung 0-3, open or closed, 24 h and 7 d counts, the ladder columns (`failed_moves`, `hunt_state`, `after_hunt_failed`, `stage`), `fixed_in` |
| `lane_pilot_wall_repair` | one repair round of a class: queued, running, fixed or held, merged, deployed, accepted, rolled back, red, released, failed; its brief, policy answer, acceptance checks, tokens |
| `lane_pilot_wall_night` | what a night did and what it spent against its cap (`spend_tokens`, `cap_tokens`) |
| `lane_pilot_wall` | the wall ladder of a class (`class:<key>`) or of a task family (`task:<hash>`): moves, the hunt with its findings, the backlog entry, the analysis |
| `lane_pilot_wall_rerun` | a planned or started re-run of a failed attempt: earliest affected stage, stages reused and stale, the head change |

All created by `wallMigrations` at the end of the migration list. The deferral register learns the kind `wall` (`wallDeferralKindMigrations`).

Sources of a night: the failed attempts of real projects (sandbox, bench and drill traffic stay out), their failure triage (the origin), the gate
events and the failed stage receipts of their tasks, and the plugin log. The log is read as the manual audit read it, by message shape: every
error line and every warning that says it failed (`logs.ts`); the watcher's own filter would have missed the relay 409 storm.

Rungs: `rungOf([c10, c100, c500])` is the highest rung whose bar holds (3 of the last 10, 5 of the last 100, 6 of the last 500). A class on rung 3 is
`closed` (within every bar); otherwise `open`. A log class has no attempts: it is open when seen on two nights of the last seven, three times in all.

## Selection, at most three a night

`select.ts`. A class qualifies when it was seen in the last 24 h, is open (or happened `recurrenceFloor` = 3 times in 7 days), has no repair under
way, is not in the backlog, and is on Lane Pilot's side (origin orchestrator / harness / infra) or recurs 3 times in 7 days without a repair. A class
seen only under older versions than the one running now waits (a release since may have fixed it, the watcher's own rule). Also refused: more than
`maxClassesPerNight` (3); `roundsPerNight` (2) rounds spent; the night's token cap would be passed; `shouldStopCycle` over the bench scores of the
series (two cycles without improvement end it). Everything refused goes to the morning list with its reason.

## The repair task

The night does not spawn threads. It queues a row (`lane_pilot_wall_repair`, state `queued`) and the self-repair watcher's own tick takes it
(`self-repair/server/hooks.ts`: `nextAssignment`, `started`, `mergeGate`, `settled`; one writer of the watcher's state). The thread is the standard
self-repair thread plus `repairBrief` (`brief.ts`): the samples, how it is proven fixed (a regression test that fails without the change; the
recurrence SQL on `lane_pilot_wall_entry` that must show 0 on the new version), the instruction to search the whole repository offline for every
other site of the class and list each as `SITE: file:line`, the round cap, the token budget and what it must not touch (the judge, the policy).
It ends with `NIGHT-REPORT: test=… sites=… class=…`. A night repair is not counted against the watcher's daily limit.

## Merge, acceptance, rollback

When the thread ends with the verdict `fixed`, the watcher asks the loop before it merges (`mergeGate`): the branch's changed files become a
change descriptor `{kind: lp_fault_repair, files, attrs: {bench_subset_passed, auto_revertible}}` and `authorize` (the night policy with its exam)
answers. `night_decides` merges; `night_proposes` and `owner_only` hold the branch (state `held`, the evidence in the morning list, released as a
patch after a week). Today the exam has no unseen owner decisions, so `authorize` degrades `night_decides` to `night_proposes`: the night merges
nothing alone yet. The bench proof is claimed only when a runnable bench set exists, and it is enforced after the deploy, not before it (see below).

After a merge the loop watches the release train (`acceptance.ts`, `decideAcceptance`): the train ran the whole suite and shipped a version; the
drill of that version is green (a red one rolls the deploy back: the plugin runs the old version again, state `rolled_back`; a version with no drill receipt of its own is not accepted, the repair waits for one and settles as `unproven` after 72 hours); the canary is quiet; the
bench subset (`benchSubset` tasks of the newest set, arm `night-<version>` against `night-<version before>`, noise aware through `bench compare`)
is not worse; the class stopped recurring on the new version, judged on attempts exposed to the class (the projects it was journaled in). A class that recurred in 10 or more of those attempts is not accepted: red, the merge is reverted. A tripped canary or a worse bench reverts the merge in code (a revert commit through the
merge queue; it ships with the next release). In every red case the class stays open and the round counts as a failed move.

## The loop guard (wall ladder)

`ladder.ts`, the same for a class and for a task family. Two normal moves (`walks`, owner default 2; Maslov takes 3) -> the hunt replaces the
third -> one informed move -> the backlog. Never an infinite retry.

- Class: a move is a repair round; a failed round is a verdict that is not `fixed`, a red acceptance, a rollback, or a class that recurred.
- Task family: the two moves are the two identical failures that already stop a task (`repeated_failure:`); `start.ts` calls `wall.noteTaskStop`.
- The hunt: three read-only readers with no tools (`task`, `system`, `big_picture` angles) on another model (`hunterProviderId`, `hunterModel`), over
  an evidence pack assembled by code (`pack.ts`). Their findings (`wall-finding-v1`) cite `file`, `receipt`, `sql` or `check_output`; code holds every
  citation against the pack, and a finding whose citation does not hold is lowered to `unknown` and never reaches the PM or the engineer.
- After a usable hunt: for a task, one service message to its PM and `dispatchGuard` refuses the same ask unchanged when the hunters found the ask itself
  wrong; for a class, an informed repair round on the hunters' model with the checked findings in its brief.
- Backlog: a failed informed move, or no usable finding. The wall becomes `backlog`, a register entry of kind `wall` (`needs_owner_term`, morning
  list, never overdue) is opened, a full analysis is written by a reader (chronology, what was tried, ranked hypotheses with evidence, the whole class,
  what a person decides), and a family in the backlog is not dispatched again (`wall_stop`). Closed by an accepted attempt of the family or
  `bb lane-pilot wall close <key> --evidence …`.

## Re-run on the new head

`packages/contracts/src/stage-inputs.ts`: `STAGE_INPUTS` (what each stage reads) and `STAGE_HEAD_DEPS` (which part of the head each stage depends on),
exhaustive over `STAGE_IDS` like `STAGE_PROOF`, and `affectedFrom(receipts, headParts, changedInputs, currentInputSha, failedStage)`: the earliest
stale stage, the stages reused and the stages stale with the reason (no receipt, not passed, head part changed, input changed, hash changed, the
failure happened here). When only judging stages are stale the mode is `rejudge` (the candidate is kept, no writer runs). `headPartsOf(change)` maps the
policy descriptor's files and settings to head parts. After an accepted repair `rerunClass` plans the class's failed attempts (the latest of their
task, not accepted since): a task of a sandbox or bench project whose earliest stage is a writer stage is restarted in place (`reopenWriterStages` +
a resumed writer, the way stability restarts a parked task); a real project, or a stage before the writer, is only listed (`wall_rerun`, state
`listed`) for the morning list. The return-to-stage operation with added context (D0-2) is not built here; it reuses these two registries.

## Settings and the cap

`bb lane-pilot wall config` (rows `wall.*` of the global level, edited on the Self-improvement page, see `docs/self-improvement-settings.md`; the old kv key `wall:config` is the fallback for a field with no row): `enabled`, `maxClassesPerNight` 3, `roundsPerNight` 2, `walks` 2, `hunters` 3, `nightTokenCap`
20 000 000, `huntShare` 0.25 (the share of the cap hunts and analyses may use), `assumedRepairTokens` 4 000 000, `hunterProviderId` / `hunterModel` /
`hunterReasoningLevel`, `benchSubset` 8, `rerunSandboxOnly` true, `recurrenceFloor` 3. Spend per night is recorded in `lane_pilot_wall_night`
(repair rows count their synced token usage, the estimate before it; hunts count theirs).

## Schedule and commands

`wall-night` at 03:00 (`runNight`), `wall-advance` at :05 :20 :35 :50 (`advance`: verdicts, merges, the release train, acceptance, task walls).
`bb lane-pilot wall status|night [--dry-run]|advance|show|close|rerun|config|morning`; RPC `wall_status`, `wall_show`, `wall_night`, `wall_config`.
`--dry-run` works inside a savepoint that is rolled back and calls no model.

The morning summary has three more lines (`composeWallMorning`, `scripts/lp-wall-morning.sql`, appended by `lp-metrics-daily.sh` when
`~/.config/lp-metrics/wall-morning.sql` is installed on the hub): the classes and the spend; the repairs (merged, accepted, held by the policy,
rolled back); the guard (hunts, backlog, re-runs).

## Known limits

- The bench cannot run before the deploy: it compares arms of different Lane Pilot versions. The policy's `bench_subset_passed` is therefore a claim
  (a runnable bench set exists) for the ordinary tier, enforced after the deploy; the descriptor also carries `bench_available` and `rollback_path_ok`
  under their own names. A change of the judge or the graph merges only provisionally and is accepted only on a passed bench subset of the version it
  shipped in. Acceptance needs evidence (a passed bench or ten attempts of the new version); without it the repair waits 72 hours and ends `unproven`,
  as it does when a later release came in. A failed revert is `rollback_pending`, retried every ten minutes up to six times, then given up into the backlog.
- Nothing ships a merged repair by itself: the release train (`bb-plugin-push`) runs where the checkout is. The loop merges, then waits for a release.
- The hunters see only the pack. For a class the pack holds the source files that emit the failure's wording (`git grep`), not the whole repository.
- Task walls start from `repeated_failure:` only; a task that ends `retry_budget_exhausted:` without it is not in the ladder.
- A re-run of a stage before the writer needs the return-to-stage operation.

## Live proof, 2026-10-22 (hub snapshot, plugin 0.1.268)

`scripts/wall-retro.ts` on a copy of the hub database and plugin logs. The night of 2026-10-20 03:00 found the classes the manual audit of
2026-10-19 found: the relay 409 storm (19 542 lines under 0.1.253-0.1.256; the audit counted 10 925 in one night), 13 red checks in 8 tasks, stray
`<paths:locale>` (8 attempts in 7 tasks) and `<paths:test>` files, «Host is not connected» for the nightly docs, the disk waits. After the 0.1.257 fix the
storm was not picked again (seen only under older versions). The dry-run night on the newest data picks one class and keeps nothing.
