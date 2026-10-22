---
title: Project memory
type: component
created: 2026-10-10
updated: 2026-10-11
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

`bb lane-pilot memory-probe <project-id> [--paths a,b] [--keep] [--clean] [--report] [--force]` (CLI `src/rooms/tools/server/cli.ts:279`; RPC `memory_probe`, `src/rooms/contracts/rpc-ops.ts:91`, `src/rooms/core/server/rpc-memory-probe.ts`) runs `createMemoryProbe().run` (`src/rooms/memory-probe/server/memory-probe.ts:136`):

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

Measured on the hub on 2026-10-22: 1532 expired notes, 1515 of them hidden by the budget eviction (`packages/memory-core/src/store.ts:139`), 17 by `valid_until`; none by the 90-day idle rule. One project (`proj_acpiaqf4wq`) holds 1374 of them: 664 accepted attempts produced 1648 notes (about 2.5 per task) in 17 days, while the note shelf (`memory.note_budget` 8000 tokens, about 130 notes) is full, so each batch evicts the oldest never-used notes: the shelf is a one-to-two-day window on busy days (10-12: 247 notes created, 38 still active a week later; 10-13: 159 created, 1 used). A writer reads at most three notes and only those naming a folder of its task (`writerMemoryPicks`), so a note about one finished task is read only if the same folder is touched again within that window. `src/rooms/learning/housekeeping.ts:5` records the same mechanism. The cause is the supply (the maintainer stores task-specific facts; 357 of 1192 passed stages stored nothing, the rest 1 to 15) against a fixed budget, not a bug; no code change was made. Options for the owner: a lower cap per task, a prompt that asks for facts that outlive the task, or a larger `memory.note_budget` for the busy projects.
