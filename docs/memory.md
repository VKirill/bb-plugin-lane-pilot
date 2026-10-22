---
title: Project memory
type: component
created: 2026-10-10
updated: 2026-10-22
status: active
confidence: high
tags: [memory, knowledge, maintenance]
sources:
  - src/rooms/memory/server/memory.ts
  - src/rooms/memory/server/session-memory.ts
  - src/rooms/memory/ui/memory-records.tsx
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/lifecycle.ts
  - packages/memory-core/src/context.ts
  - src/rooms/storage/database.ts
  - src/rooms/contracts/rpc-knowledge.ts
  - src/rooms/memory-eval/server/memory-eval.ts
  - src/rooms/memory-eval/server/shelf.ts
  - src/rooms/memory/server/memory-conflicts.ts
  - packages/memory-core/src/conflicts.ts
  - packages/memory-core/src/conflict-store.ts
---

# Project memory

TL;DR: Project memory stores scoped records in plugin SQLite, exposes search and maintenance through RPC and PM tools, and records maintenance as a writer-stage receipt.

## Purpose

Keep project facts and rules available to PM, writer, and terminal sessions through a shared hub-side memory store (`src/rooms/memory/server/session-memory.ts:11-15`, `src/rooms/storage/database.ts:157-168`).

## How it works

1. `session_memory_project` maps a host path to the deepest matching project scope (`src/rooms/memory/server/session-memory.ts:18-30`).
2. `session_memory_write` validates a candidate, stores it for the `subagent` audience as `observed`, and returns an inserted, corroborated, duplicate, disabled, or validation result (`src/rooms/memory/server/session-memory.ts:32-48`).
3. `session_memory_search` retrieves subagent-visible records; `session_memory_core` returns active core records whose expiry is unset or in the future (`src/rooms/memory/server/session-memory.ts:50-59`).
4. `createMemoryStage` runs after acceptance and validates PM/run/task ownership and requires a passed acceptance receipt before starting maintenance (`src/rooms/memory/server/memory.ts:22-47`).
5. The maintenance stage creates or resumes one `memory-maintenance` stage receipt and skips work when memory is disabled or maintenance is off (`src/rooms/memory/server/memory.ts:58-83`).
6. `MemoryRecords` loads the project's rows on mount and when `projectId` changes; a list RPC failure becomes an empty list (`src/rooms/memory/ui/memory-records.tsx:18-23`).
7. It partitions rows by `rule`, then renders separate fact and rule disclosures. Each row shows its kind, creation date, content, and at most eight concepts; only fact rows render a remove button (`src/rooms/memory/ui/memory-records.tsx:36-50`, `:53-62`).
8. Removing a fact marks that row busy and calls `memory_record_delete`. A refusal shows the rule-specific or missing-record toast; success reloads the list; a thrown error is shown as a toast, and `finally` clears the busy row (`src/rooms/memory/ui/memory-records.tsx:25-34`).

## Modes and states

| Mode or state | Behavior | Evidence |
|---|---|---|
| Memory disabled | A session write returns `memory_disabled`; maintenance records a skipped stage (`src/rooms/memory/server/session-memory.ts:32-35`, `src/rooms/memory/server/memory.ts:65-70`). |
| Observed session record | Stored for `subagent`, with `trust: observed` and `origin: session` (`src/rooms/memory/server/session-memory.ts:38-45`). |
| Accepted task | Memory maintenance can run only after the writer acceptance receipt passed (`src/rooms/memory/server/memory.ts:43-47`). |
| Existing terminal maintenance receipt | Reuse the prior result; another maintenance pass requires a new task (`src/rooms/memory/server/memory.ts:61-64`). |
| Rule record | Displayed separately and cannot be deleted through the facts action (`src/rooms/memory/ui/memory-records.tsx:36-46`). |
| List request failed | The UI stores an empty list; its disclosures render their empty state rather than an RPC error (`src/rooms/memory/ui/memory-records.tsx:18-21`, `:56-61`). |
| Delete refused or throws | A refusal displays the rule or gone message and reloads; a thrown error displays its message; both clear the busy state (`src/rooms/memory/ui/memory-records.tsx:25-34`). |

## Business rules

Memory writes are scoped by project, personal bot, audience, source hash, and parsed memory settings (`src/rooms/memory/server/session-memory.ts:32-45`). Core records returned to sessions must be active and unexpired (`src/rooms/memory/server/session-memory.ts:55-58`).

## Public API or commands

`sessionMemoryRpc` implements the session RPC methods: `session_memory_project`, `session_memory_write`, `session_memory_search`, `session_memory_core`, and `session_lesson` (`src/rooms/memory/server/session-memory.ts:15-18`, `:60-67`). The knowledge RPC contract defines the UI-facing memory record list and delete endpoints (`src/rooms/contracts/rpc-knowledge.ts:90-102`).

## Gotchas

Maintenance starts asynchronously after acceptance, retries observation while a child is running, and treats its stage receipt as the idempotency record (`src/rooms/memory/server/memory.ts:22-34`, `:61-83`). The data tables and field meanings are indexed in [data model](data-model.md).

## Memory you can prove: the delivery paths and the probe (SMA block 4, P0-3)

Matvey Maslov's system carried zero lessons through one delivery path for three months and nobody saw it, because nothing asked a path whether it delivers. Here every path is named once, a probe asks each of them, and the drill turns a silent path red.

### The registry

`MEMORY_PATHS` (`src/rooms/memory/memory-paths.ts:45`) lists every way project memory, rules and owner facts reach an agent: `writer.brief`, `writer.turn`, `writer.repair`, `pm.start`, `pm.resume`, `pm.rules_tool`, `pm.memory_tool`, `critic.code`, `night.review`, `council.evidence`, `terminal.search`, `terminal.core` (probed) and `maintainer.existing`, `memory.golden_eval`, `pm.owner_card` (exempt, each with its reason). Each entry names what the path `carries` (note, core, rule), what it hands to every task by design (`alwaysOn`) and its injection sites: a file, a primitive from `MEMORY_PRIMITIVES` (`:37`) and how many calls. `tests/memory-paths.test.ts` scans `src/` for those primitives and fails when a call appears or disappears without a registry change, so a new reader of memory cannot ship unregistered. The helpers that read no memory (pm-read, reflection, the harness editor, which sees past briefs only as trace evidence) have no primitive to register; a new call to one of the primitives in them fails the test.

The sites share one function where they used to build their own copy: `writerKnowledge` / `writerRules` / `stickyTurnPromptWithRules` (`src/rooms/writer/server/writer-knowledge.ts:47`, `:39`, `:61`) for the first brief (`src/rooms/writer/server/spawn.ts:148`) and the continuing turn (`src/rooms/writer/server/start.ts:471`), `pmResumeInstructions` (`src/rooms/learning/pm-rules.ts:51`, called at `src/rooms/learning/service.ts:234`), `pmMemoryContext` (`src/rooms/memory/server/memory-mix.ts:55`) and `councilMemoryBlock` (`src/rooms/council/server/council.ts:108`, used at `:221`). The probe calls the same functions production calls.

A defect found by writing the registry: `stickyTurnPrompt` had a `rulesText` parameter that its only caller never passed, so a writer thread continued with the next task of its area got no rules. The next-task turn now carries the rules that apply to its contract (a retry or merge keeps the first brief's rules).

### The probe

`bb lane-pilot memory-probe <project-id> [--paths a,b] [--keep] [--clean] [--report] [--force]` (CLI `src/rooms/tools/server/cli.ts:286`; RPC `memory_probe`, `src/rooms/contracts/rpc-ops.ts:91`, `src/rooms/core/server/rpc-memory-probe.ts`) runs `createMemoryProbe().run` (`src/rooms/memory-probe/server/memory-probe.ts:136`):

1. Refuses a project that is not a sandbox (`proj_3tb652jpsi` and `LP_MEMORY_PROBE_PROJECTS`, `:36`) unless `--force`.
2. Removes what an earlier run left, then plants through the write door (`storeMemoryRecords`, the function the maintainer and the session RPC use; `:153`) a note that names the folder `lp-probe/memory`, a core convention, and through the lesson door (`upsertLessonProposal` + `adoptRuleProposal`) an always-on rule for both audiences. Every record carries a unique token (`lpprobe<8 hex><n|c|r>`), `trust: confirmed`, `origin: probe` and `valid_until` one day ahead (`:33`).
3. For every probed path builds what the agent receives and looks for the tokens (`PROBES`, `:68`): the brief text from `writerKnowledge` + `writerBriefSegments` (writer.brief), the next-task turn (writer.turn), `codeRepairPrompt` with the dispatch context (writer.repair), `pmRulesPromptBlock` (pm.start), `pmResumeInstructions` (pm.resume), `pmRulesOf` (pm.rules_tool), `pmMemoryContext` (pm.memory_tool), `codeCritiquePrompt` and `nightReviewPrompt` over `reviewerMemoryFor` (critic.code, night.review), `councilMemoryBlock` (council.evidence), the `session_memory_search` and `session_memory_core` handlers (terminal.*). A path passes when every kind it carries is in the text (`judge`, `:206`).
4. Negative case: the same path for a task in an unrelated folder, and for a gibberish query. A kind the path does not hand to every task (`alwaysOn`) must not show up, and the gibberish query must pull no record.
5. Writes one row per path into `lane_pilot_memory_probe` (path, found, negative_ok, latency_ms, lp_version, at, detail, token; `src/rooms/storage/database.ts:340`, the last migration when it was added) and removes its records unless `--keep`. Exit 1 when any path is red. `--report` prints the last run and `memoryUnanswered` (`src/rooms/learning/unanswered.ts:17`).

Observed (single-session) records wait a day for writers (`OBSERVED_QUARANTINE_MS`, `packages/memory-core/src/lifecycle.ts:5`), so the probe writes trusted records; a session-written note is visible to `lane-memory` at once and to a writer after a day or a second source, by design.

### The drill

`scenario_memory_paths` (`scripts/lp-drill.py:509`, listed in `QUICK` at `:72`) plants with `--keep` before the drill's PM starts, then fails when: a probe row is red or its negative case pulled our records; the drill PM's first prompt lacks the probe rule (read from `bb thread log`); a real writer spawned for a probe task (`task_memory`, cancelled once its thread exists) lacks the probe note, core or rule in its first prompt; `lane-memory search` / `core` in the sandbox folder do not return the records (skipped when the host has no `lane-memory`). Records are removed at the end and in the final `finally`. A red drill already blocks the deploy (the push script rolls back on it). Tests: `tests/lp-drill-memory-paths.test.ts` (fake `bb`, `ssh`, `lane-memory`), `tests/server/memory-probe.test.ts`, `tests/memory-paths.test.ts`.

### The metric: a question memory did not answer

`memoryUnanswered` (`src/rooms/learning/unanswered.ts:17`) counts, per project over 30 days, learning items in state `duplicate` (the owner said again what was already in force; `confirmations` counted) and `owner_question` signals with p >= 0.6 (an agent asked the owner what another agent or the memory could have answered). Items are written only while the learning room is `active`; on the hub it is still observing, so the first number is 0 and the second is the signal (27 `owner_question` rows on 2026-10-22).

### Why 1532 expired notes were almost never used

Measured on the hub on 2026-10-22: 1532 expired notes, 1515 of them hidden by the budget eviction (`packages/memory-core/src/store.ts:139`), 17 by `valid_until`; none by the 90-day idle rule. One project (`proj_acpiaqf4wq`) holds 1374 of them: 664 accepted attempts produced 1648 notes (about 2.5 per task) in 17 days, while the note shelf (`memory.note_budget` 8000 tokens, about 130 notes) is full, so each batch evicts the oldest never-used notes: the shelf is a one-to-two-day window on busy days (10-12: 247 notes created, 38 still active a week later; 10-13: 159 created, 1 used). A writer reads at most three notes and only those naming a folder of its task (`writerMemoryPicks`), so a note about one finished task is read only if the same folder is touched again within that window. `src/rooms/learning/housekeeping.ts:5` records the same mechanism. The cause is the supply (the maintainer stores task-specific facts; 357 of 1192 passed stages stored nothing, the rest 1 to 15) against a fixed budget, not a bug. The options (a cap per task, a prompt for facts that outlive the task, a larger budget) were then measured: see «Supply against the budget, measured» below.

## Evaluation: 30, 300 and 3,000 notes, and questions whose answer is nothing (SMA block 4 «Next», P2-7)

`bb lane-pilot memory-eval [--sizes 30,300,3000] [--seed N] [--scope project|pile] [--floor] [--no-floor] [--source <extract.db>] [--json]` (`src/rooms/memory-eval/server/`, standalone `npx tsx scripts/memory-eval.ts --source <file>`) builds a corpus of each size from the notes the hub really holds and asks it the questions real accepted tasks pose. It reads the plugin database and writes nothing (`--export <file>` makes a small extract of the two things it needs, the notes and the accepted tasks with the files their accepted attempt produced, so the run can happen on any machine).

- **Question.** An accepted task: the words `writerKnowledge` searches with (title, objective, acceptance) and its path lists (`owns_paths`, `read_first`).
- **Gold answer.** From the outcome, not from the retrieval: the notes written before the attempt started that name a file the accepted attempt really produced (`produced` of the acceptance receipt, last two path segments). A lower bound, since a note can help without naming a file: precision against gold is a floor, and «nearby» counts delivered notes that name the same folder.
- **Negative question.** A real task for which the right answer is nothing: no earlier note names a file or folder of its solution. Plus six off-topic questions (a borscht recipe, gibberish). A delivered note is a false hit; core conventions are reported apart because the writer's brief hands them to every task by design (and the reviewer path hands over every review-tagged note by design, so its off-topic figure is not comparable).
- **Sizes.** The gold notes of the chosen questions are always in the corpus (they may take 50 % of 30 notes, 35 % of 300, 10 % of 3,000), the rest is real filler from the hub, and what the hub does not have (it holds about 2,200 notes ever) is padded with copies of real notes whose folders are renamed (`apps/api/x.ts` becomes `apps-s1/api-s1/x.ts`): they read like the project and name no file anyone touched. `--scope project` keeps each note in its own project as production does; `--scope pile` puts a person's whole memory in one scope (the harder test). A note written after a task started is hidden from it.
- **Retrievals.** The production ones are the very functions the delivery paths call: `mixWriterMemory` (writer brief), `searchMemoryRecords` + `memoryContext` (PM tool, terminal, council), `searchMemoryRecords` alone, `mixReviewerMemory` (critics, night review). Against them the plain baseline Maslov's claim asks for: **plain** (a note names a folder of the task, the one with most uncommon task words first; no stemming, no trigram index, no rank fusion, no counters) for the writer path, **plain-keyword** (at least three uncommon words in common) for the query paths, and a diagnostic `search+floor` (the production search with a floor of three shared words). Every number comes with a 95 % bootstrap interval; the questions are the sample.

Measured on the hub's data of 2026-10-22 (project scope, 3 seeds; ranges are the seeds; hit@k is «a gold note among the k delivered», false hit is «something other than core delivered for a question whose answer is nothing»):

| | 30 notes | 300 notes | 3,000 notes |
|---|---|---|---|
| writer path, hit@3 | 60-100 % (plain: the same) | 77-86 % (plain 72-92 %) | 70-76 % (plain 68-73 %) |
| writer path, false hit | 0 % (plain 0 %) | 6-14 % (plain 8-14 %) | 7-14 % (plain 16-23 %) |
| PM / terminal context (`pm`), hit@5 | 100 % | 77-95 % | 51-66 % |
| PM / terminal context, false hit | 30-69 % | 81-88 % | 85-88 % |
| plain-keyword, hit@5 / false hit | 47-73 % / 4-13 % | 43-59 % / 18-29 % | 41-48 % / 45-55 % |
| p50 latency, writer path / plain | 0.4-1.4 / 0.0 ms | 1.8-4.5 / 0.0-0.1 ms | 12.5-16.5 / 0.2-0.5 ms |

What it says, honestly:

1. **Plain does not beat clever on the writer path; they tie.** The writer's brief is already «plain» at its core (a note must name a folder of the task); the full-text search in front of it adds nothing measurable to the hit rate (differences of -6 to +5 points, every interval contains zero) and makes it slightly quieter on questions that have no answer at 3,000 notes (7-14 % false hits against 16-23 %, a difference of 9 points, interval [3, 16], the same in all three seeds). Cost: 13 ms against 0.3 ms at 3,000 notes, which does not matter.
2. **On the query paths plain loses on recall and clever fails on silence.** The production search finds the gold note for 60-87 % of the questions at 300 notes, but returns something for 81-91 % of the questions whose answer is nothing: there is no relevance floor, any shared word is enough. The plain keyword rule is quiet but finds half as much (44 % against 77-87 % at 300). A floor of three shared words on the production search keeps the recall (86 % against 87 %) and cuts the false hits from 81 % to 58 % at 300 notes; at 3,000 notes it does not help (83 %). The floor of three shared words was only a diagnostic; the floor that is now in the query paths is chosen and measured in «The relevance floor of the query paths» below.
3. **The ranking was the real defect, and it is fixed.** In a static corpus all counters are zero and the two agree. On the real shelf the writer's three notes were ordered by how often a note had been in an accepted brief (`memoryUsefulness`), ahead of how well it matched: with a median of 10 notes naming a task's folders the best match was pushed out by notes picked before. Replaying the hub's history through the real write door (`memory-eval --shelf`, 569 real tasks with an answer on record), hit@3 was **41 %** with the counters first and is **62 %** with the search's order; `writerMemoryPicks` keeps the search's order now (the counters still rank the PM context and the reviewers' tiers). `tests/server/memory-usefulness.test.ts` pins it.

### The relevance floor of the query paths

The finding of item 2, acted on. `packages/memory-core/src/floor.ts` (`relevantRecords`) sits between the search and what the PM tool (`lane_pilot_memory_context`), the council's evidence pack and the terminal's `lane-memory search` (`session_memory_search`) hand over. The writer's brief and the reviewers do not use it (the writer's path anchors are a floor of their own; reviewers get review-tagged notes by design). A record clears the floor when it names a path written in the question (the last two segments, as the writer's brief matches), or when the words it shares with the question weigh enough together. A word weighs `ln(1 + notes / notes holding it) / ln(1 + notes)` in the project's own notes (about 1 for a word one note holds, 0.1 for a word in half of them), so there is no word list and the scale does not move with the size of the memory. The weight to reach depends on the length of the question, because a whole task text shares many words with the notes by chance and a title cannot: **2 at 17 distinct words and more, 0 at 12 and fewer, a straight line between** (`DEFAULT_RELEVANCE_FLOOR`; the two lengths are where the evaluation's titles and full task texts part). When nothing clears it, the answer says so plainly: `session_memory_search` returns `{records: [], nothingRelevant: true, message: "Memory has nothing relevant to this query. Do not assume or invent project facts; read the code or ask the owner."}`, and the PM tool packet gets `nothingRelevant: true` with the same sentence in `context` (`recordIds` empty); the old fields are unchanged and the new ones appear only when there is nothing (a client that reads `records` alone, like today's `lane-memory`, sees an empty list as before; making that CLI print the message is a change in the Lane Stack repo). The old behaviour is one argument away (`relevantRecords(..., {floor: null})`; `memory-eval --no-floor`; the `pm-nofloor` and `search-nofloor` rows of the report).

**How it was chosen, and what it costs.** `memory-eval --floor`: the questions are split in two halves by a hash of their task (a task is on the same side at every size), the floor is chosen on the tuning half and the numbers below are the **held-out** half. The rule was fixed before looking: the lowest false-hit rate on the tuning half among the floors that lose at most 5 points of hit@5, on both query paths. Stage 1 sets the weight on the full task text, stage 2 sets the weight for a short question on the titles alone (every question is asked both ways). Seed 1, project scope, the hub's data of 2026-10-22, 78 positive and 96 nothing-questions held out (pooled over the three sizes):

| held-out, full task text | 30 | 300 | 3,000 | all |
|---|---|---|---|---|
| PM tool, hit@5 old → new | 100 → 100 % (2 questions) | 77 → 69 % | 57 → 51 % | 68 → 62 % |
| PM tool, false hit old → new | 44 → 44 % | 85 → 76 % | 87 → 76 % | 82 → 73 % |
| terminal search, hit@5 old → new | 100 → 100 % | 82 → 72 % | 57 → 41 % | 71 → 58 % |
| terminal search, false hit old → new | 44 → 44 % | 85 → 76 % | 87 → 76 % | 82 → 73 % |
| title only (8 words), PM tool, hit@5 / false hit | | | | 65 → 65 % / 77 → 76 % |

On the tuning half the same floor costs 2 points of hit@5 (78 → 76 %) and removes 11 points of false hits (79 → 68 %). The trade-off curve on that half (full task text; hit@5 / false hit): weight 1.5: 78 / 66 %; **2: 76 / 59 %**; 2.25: 74 / 53 %; 2.5: 66 / 48 %; 3: 55 / 35 %; 3.5: 50 / 23 %; 4: 43 / 17 %. For titles: 0.25: 71 / 66 %; 0.5: 68 / 58 %; 0.75: 67 / 46 %; 1: 59 / 37 %; 1.25: 45 / 18 %. The knee of the full-text curve is 2 to 2.25; the rule picks 2. For titles no floor stays within 5 points of hit@5 on both paths (the first step, 0.25, already loses 7 points on the terminal path), so **short questions are not floored**: the choice is 0, and 0.5 (−8 points of hit, −14 of false hit) or 0.75 (−9 / −26) is a one-constant change if the owner wants silence over recall there.

What it says, honestly:

1. **A lexical floor buys silence at the price of recall along one curve, and there is no free part of it.** Whatever the rule (summed weight, a count of uncommon words, coverage of the question, shared words with a minimum weight), the points fell on the same frontier: the best discriminator, the summed weight of the shared words, separates a task that has an answer from one that has not with an AUC of 0.81 (tuning half; 0.84 at 300 notes, 0.73 at 3,000), and the notes that are the gold of a task often share little with its text. At 3,000 notes (with 809 padded copies of real notes) the false-hit rate stays at 76 % after the floor.
2. **The target «cut false hits substantially at about 5 points of hit» was not met on the held-out half.** The PM tool loses 6 points of hit@5 and 9 points of false hits (82 → 73 %); the terminal path, which hands the fused ranking over as it is, loses 13 points for the same 9 (that half has 78 positive questions, so an interval is about ±10 points; the tuning half lost 2 and 4). What the floor does is certain at the clear cases (a question that shares nothing uncommon with the notes gets the explicit «nothing»), not at the many questions that are about the same project and its vocabulary: the real nothing-questions are tasks of the same project, so a note that shares their topic is delivered, and by the gold's definition (a note naming a produced file) it counts as a false hit.
3. **The six off-topic questions are mostly short, and short questions are not floored**: 3 of the 6 (borscht, weather, chess) still get a note in the production `pm` row (50 %, unchanged), the gibberish and Russian ones were already empty. Flooring them would cost the recall of every short question.
4. **Cost.** Reading the project's word counts once per change of the notes (cached) and weighing at most 100 records: +1 ms at p50 at 3,000 notes (13.3 against 12.2 ms).

The production rows of the report after the change (project scope, seed 1, hit@5 / false hit; the `-nofloor` rows are the old behaviour): `pm` 30 notes 100 % / 29 % (was 100 / 41), 300 notes 72 / 71 % (was 77 / 81), 3,000 notes 63 / 79 % (was 66 / 88); `search` 100 / 29, 76 / 71 (was 87 / 81), 54 / 79 (was 60 / 88). Tests: `tests/memory-floor.test.ts` (kept and dropped notes, the path anchor, a short question, the threshold, both RPC/tool shapes, the old behaviour), `tests/memory-eval.test.ts` (`--no-floor`, the tuning split).

## Supply against the budget, measured (P0-3 finding)

`memory-eval --shelf` replays the hub's notes batch by batch and its accepted tasks in time order through the real write door (`storeMemoryRecords`, with its eviction) and the real search, and asks at every task whether a note naming a produced file was still on the shelf and whether the writer's three notes included one (569 tasks, 2,191 notes written):

| configuration | gold on shelf | hit@3 | notes written | evicted |
|---|---|---|---|---|
| legacy order, budget 8000 (before) | 84 % | 41 % | 2191 | 1654 |
| relevance order, budget 8000 | 83 % | 62 % | 2191 | 1683 |
| relevance order, budget **24000** (now) | 92 % | **69 %** | 2191 | 1303 |
| relevance order, 8000, cap 1 note per task | 72 % | 53 % | 841 | 451 |
| relevance order, 8000, cap 2 per task | 79 % | 56 % | 1244 | 808 |
| relevance order, 24000, cap 2 per task | 90 % | 70 % | 1244 | 562 |

- **A cap per task lowers recall** (62 % to 53-56 % at the old budget): the notes it drops are chosen by how many files they name, and that is a weak guess at which note a later task needs (48 % of all the hub's notes were later the answer of some task). Not implemented. The prompt option (ask for facts that outlive the task) cannot be replayed on history and was not tried.
- **A larger budget raises it** (62 % to 69 %), and costs no brief space: a writer reads at most three notes whatever the shelf holds, the PM context has its own `memory.context_budget`. `memory.note_budget` now defaults to **24000** tokens (`packages/memory-core/src/settings.ts`, the catalog default in `packages/settings-catalog/src/ui-catalog.ts`); the hub's projects set none, so they take the new default at the next deploy. The total index budget (65536) is unchanged.
- The shelf is still a window: with 2.5 notes per task and about 400 notes a project holds a few days of busy work, not weeks. The gap that remains (92 % on the shelf, 69 % picked) is retrieval, not supply.

## Contradictions: two notes that disagree are held until a person settles it

`findConflicts` (`packages/memory-core/src/conflicts.ts`) compares a note written now with the active notes of its project and audience. Deterministic heuristics, conservative on purpose (a missed conflict leaves two notes in circulation as today; a false one holds two good notes back): the two notes are about the same thing (they name the same file path, or share at least three tags that are most of their tags) and disagree in one of three ways: **value** (the same quantity next to the same two label words with two numbers: «cache TTL of 24 h» and «cache TTL of 48 h»), **literal** (the same constant or key with two values: `` `MAX_UPLOAD_MB` = `10` `` and `` = `25` ``) or **polarity** (a sentence of at least five content words once affirmed and once negated, 80 % of the words equal after the negation is taken out). Near-identical restatements are not conflicts: `sameSubject` replaces the older wording at write (two shared tags and similar words), which is also why the real corpus has almost none left. No model is asked; a judge for the ambiguous pairs would be the next step if the heuristics miss real ones.

On the hub's 2,191 notes ever stored (the sandbox excluded), 0 pairs of active notes conflict; the history holds 1 pair (two expired notes about a breakpoint, `Below 1024px` against `Below 1280 px`, the same admin page). The first version of the polarity rule found 3 more, all false (a negation in another clause of the same sentence); the 0.8 word overlap removed them. The register is a mechanism waiting for its first real case, not a backlog.

**What is held and how.** After every maintainer write and every session write the new notes are compared; a pair that disagrees gets a row in `lane_pilot_memory_conflict` (state `held`) and **both notes leave every reader through one SQL clause** (`heldClause`, used by `searchMemoryRecords`, `listMemory`, `session_memory_core` and the lane-memory file export): the writer's brief, the reviewers, the PM tool, the council, the terminal's core block. The notes stay `active` in the table, so budgets still count them and nothing is lost. **Why hold both rather than inject both with a «conflict, owner to settle» marker:** an agent cannot weigh two facts neither of which it can check, a marker invites a guess and costs tokens in every brief that carries it, and a wrong «fact» is worse than a missing one (the task's read list still points at the code). The conflict reaches a person through the deferral register instead.

**The term.** Each held conflict opens a deferral of the new kind `memory_conflict` (`dfr_mc_<10 hex>_<10 hex>`, the `deferral` table was rebuilt for the wider CHECK), state `needs_owner_term`: it is in the morning list and counted in the daily report, never overdue, and **only the owner's message gives it a date** (`bb lane-pilot defer <dfr_id> --owner-msg <thread>#<seq>`, the same rules as any deferral: the code reads the message). A date that passes turns the deploy drill red like any other deferral. A project holds at most 25 held conflicts: beyond that the heuristics are misfiring and no more entries open (the log says so).

`bb lane-pilot memory-conflicts [--project P] [--state held|settled] [--detect]` lists them (and looks for new ones); `bb lane-pilot memory-conflict-settle <mc_id> --keep a|b|both|none --evidence <why>` settles: `a` (the older) or `b` keeps one and retires the other as superseded by it, `both` says they do not disagree (the pair is never held again), `none` retires both; the evidence is required and closes the deferral. A conflict whose note was replaced, evicted or expired settles itself as `moot`. Tests: `tests/memory-conflicts.test.ts`, `tests/memory-eval.test.ts`.
