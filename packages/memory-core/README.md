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
| `storeMemoryRecords(db, input)` | Inserts new candidates inside the budgets, in one transaction. A full note shelf hides the least useful notes instead of refusing (`evictedIds`); a restated or named note replaces the older one (`supersededIds`); dates and 90 idle days expire notes (`expiredIds`); a second source confirms an observed record (`corroboratedIds`) |
| `searchMemoryRecords(db, projectId, query, limit, engine, audience?, bot?, options?)` | FTS5 word index (`bm25` ranking) fused with an FTS5 trigram index (word forms and substrings; an in-code scan where SQLite lacks the tokenizer), or a plain lexical fallback; only active, in-date records, and observed ones only after a second source or the quarantine (`options.includeObserved` for the session that wrote them) |
| `listMemory(db, projectId, {kind?, concepts?}, limit, ...)` | Visible records by kind or tag, whatever the task's words: what a role (a reviewer) always wants |
| `memoryUsefulness(record)`, `recordMemoryMixed`, `recordMemoryAccepted` | How often a record went into a brief and how often that attempt was accepted; used by ranking |
| `memoryContext(records, taskText, budget)` | Packs the most relevant records under a token budget into prompt text, by word stem, weighted by usefulness |
| `memoryMaintenancePrompt(input)` | The prompt for the maintenance model |
| `estimateTokens(text)` | The budget unit used everywhere here |

## Files

claude-lane keeps memory as `.agents/memory/<id>.md` files with YAML front matter (schema 2).
`parseLaneMemoryFile` reads the fields that matter, `laneMemoryFileToCandidate` maps a file to a
record and an audience (public → export, internal → subagent, sensitive → owner), and
`renderLaneMemoryFile` writes a record back as a file every CLI hook indexes like any other.

## Storage

The package expects the `lane_pilot_memory` table and its `lane_pilot_memory_fts` FTS5 index. The trigram index `lane_pilot_memory_trgm` it makes itself on first use.
Their migrations stay with the owning plugin (Lane Pilot: `src/database.ts`) because the
migration history of an installed database cannot be renumbered. `MEMORY_SCHEMA` documents the
expected columns for another plugin that wants to host the same corpus.

## Who may use it

Lane Pilot stages, the council, MoA advisors, or any plugin that wants per-project agent memory
with the same guards. Depends on `better-sqlite3` types only.
