# @lane-pilot/memory-core

One place for what agents learn about a project. Records are short facts with a kind (`core` is
always loaded, `note` is retrieved), an audience (`owner`, `subagent`, `export`), concepts for
retrieval, and a token budget that is enforced before anything is stored or injected.

## Contract

| Export | What it does |
|---|---|
| `parseMemorySettings(raw)` | Validates the `memory.*` settings object into `MemorySettings` |
| `parseMemoryCandidates(raw, settings)` | Validates a model's JSON output; rejects credentials, instruction overrides, oversize entries and budget overruns |
| `memoryRecordId(projectId, kind, content, bot?)` | Stable id: the same fact stored twice is one record |
| `storeMemoryRecords(db, input)` | Inserts new candidates inside the budgets, in one transaction; returns the corpus and the inserted ids |
| `searchMemoryRecords(db, projectId, query, limit, engine, audience?, bot?)` | FTS5 (`bm25` ranking) or a plain lexical fallback |
| `memoryContext(records, taskText, budget)` | Packs the most relevant records under a token budget into prompt text |
| `memoryMaintenancePrompt(input)` | The prompt for the maintenance model |
| `estimateTokens(text)` | The budget unit used everywhere here |

## Storage

The package expects the `lane_pilot_memory` table and its `lane_pilot_memory_fts` FTS5 index.
Their migrations stay with the owning plugin (Lane Pilot: `src/database.ts`) because the
migration history of an installed database cannot be renumbered. `MEMORY_SCHEMA` documents the
expected columns for another plugin that wants to host the same corpus.

## Who may use it

Lane Pilot stages, the council, MoA advisors, or any plugin that wants per-project agent memory
with the same guards. Depends on `better-sqlite3` types only.
