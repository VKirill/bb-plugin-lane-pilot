---
title: Memory search and retrieval
type: component
created: 2026-11-07
updated: 2026-11-07
status: active
confidence: medium
tags: [memory, search, retrieval, fts5, bm25, vectors, scoping]
sources:
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/vectors.ts
  - packages/memory-core/src/terms.ts
  - packages/memory-core/src/floor.ts
  - packages/memory-core/src/sections.ts
  - packages/memory-core/src/conflict-store.ts
  - packages/memory-core/src/lifecycle.ts
  - packages/memory-core/src/settings.ts
  - src/rooms/storage/database.ts
  - src/rooms/memory/server/session-memory.ts
---

# Memory search and retrieval

TL;DR: Search merges whole-word BM25 hits, trigram substring matches, and dense vector rankings with section scoping and visibility filters.

## Purpose

The search subsystem retrieves active project facts and rules matching natural language queries, keyword terms, or role concepts while enforcing tenant permissions, audience visibility, section isolation, and conflict exclusion (`packages/memory-core/src/store.ts:305-353`, `packages/memory-core/src/store.ts:398-405`).

## How it works

1. Query tokenization: `memoryTokens` extracts word tokens (alphanumeric, underscores, hyphens) of 3 or more characters; the search caps distinct tokens at 32 (`packages/memory-core/src/terms.ts:2-4`, `packages/memory-core/src/store.ts:324`).
2. FTS5 BM25 whole-word search: when `engine !== "bm25"`, queries the `lane_pilot_memory_fts` virtual table using SQLite `MATCH` with `OR` combinations, ordered by `bm25(lane_pilot_memory_fts)` (`packages/memory-core/src/store.ts:327-332`).
3. Trigram substring search: tokens are stemmed via `memoryStem` (stripping two letters from tokens >= 6 characters); if `trigramReady` succeeds, queries `lane_pilot_memory_trgm` via `MATCH` and `bm25()` (`packages/memory-core/src/terms.ts:10-12`, `packages/memory-core/src/store.ts:333-339`). If trigram FTS5 is unsupported, falls back to in-memory `scanRows` (`packages/memory-core/src/store.ts:340`, `packages/memory-core/src/store.ts:388-392`).
4. Reciprocal Rank Fusion: `fuse` merges the word and stem result lists using reciprocal rank scores: $\sum 1 / (60 + \text{rank} + 1)$, breaking ties by record creation time (`packages/memory-core/src/store.ts:341`, `packages/memory-core/src/store.ts:378-385`).
5. Dense vector re-ranking: `denseRows` inspects whether a precomputed query vector is registered in memory via `queryVectorFor` (`packages/memory-core/src/store.ts:360-362`, `packages/memory-core/src/vectors.ts:110`). If available:
   - Queries all vectored records for the project via `denseRank` (`packages/memory-core/src/vectors.ts:84-96`), computing the dot product with `unit` normalized vectors (`packages/memory-core/src/vectors.ts:55-60`).
   - Prioritizes lexical matches that contain path anchors named in the query (`packages/memory-core/src/store.ts:367-371`).
   - Appends visible records sorted by cosine similarity (`packages/memory-core/src/store.ts:372`).
   - Appends any remaining word matches that lack vector embeddings at the tail (`packages/memory-core/src/store.ts:373`).
6. Fallback BM25 scoring: if `engine === "bm25"`, queries all visible rows directly and scores each record by counting query token occurrences across `content` and `concepts_json` (`packages/memory-core/src/store.ts:344-348`).
7. Visibility enforcement: every search path applies `visibility`, ensuring rows meet active status, valid time window, non-idleness, trust quarantine, absence of held conflicts (`heldClause`), and section scope match (`packages/memory-core/src/store.ts:305-311`, `packages/memory-core/src/conflict-store.ts:62-65`).
8. Concept and kind listing: `listMemory` allows roles to retrieve visible records filtered by kind (`"core"` or `"note"`) and concept tags without requiring a text query, sorted by creation timestamp descending (`packages/memory-core/src/store.ts:398-405`).

## Modes, variants and branches

| Search mode / branch | Inputs and flags | Scoring and matching | Outputs and limits | Evidence |
|---|---|---|---|---|
| Auto / FTS5 (`engine !== "bm25"`) | Default search engine setting | FTS5 whole-word BM25 + FTS5 trigram BM25 fused via RRF | Returns top `limit` records | `packages/memory-core/src/store.ts:327-343` |
| In-code fallback scan | Triggered when SQLite lacks trigram tokenizer | In-code substring counting of stems across content and concepts | `scanRows` substituted into RRF fusion (`packages/memory-core/src/store.ts:340`, `packages/memory-core/src/store.ts:388-392`) | `packages/memory-core/src/store.ts:335-340` |
| Token frequency fallback | Engine option in `MEMORY_SEARCH_ENGINES` (`packages/memory-core/src/settings.ts:2, 62`) | Direct token frequency scoring (`_score`) against visible project rows | Scored and sorted in memory (`packages/memory-core/src/store.ts:344-348`) | Evaluates all visible rows |
| Dense semantic search | Caller registers vector via `rememberQueryVector` (`packages/memory-core/src/vectors.ts:105-109`) | `denseRows` (`packages/memory-core/src/store.ts:360-375`) re-ranks by `denseRank` (`packages/memory-core/src/vectors.ts:84-96`) | Records carry `.similarity` | Ranked by cosine |
| Standard search (`searchMemoryRecords`) | Standard working reader | Scoped to project root and reader's section chain (`options.chain`) | Excludes sibling sections | `packages/memory-core/src/store.ts:285-288, 323` |
| Admin search (`searchMemoryAllSections`) | Admin or maintenance query | `options.allSections = true` | Searches across all sections of the project | `packages/memory-core/src/store.ts:319-321` |
| Concept listing (`listMemory`) | Target `kind` and `concepts` array | Direct SQL filtering on `kind` and `concepts_json LIKE` | Newest visible records first | `packages/memory-core/src/store.ts:398-405` |

## Failure behavior

| Failure condition | Handling mechanism | Outcome | Evidence |
|---|---|---|---|
| Empty query or non-positive limit | Short-circuit guard in `searchMemoryRecords` (`packages/memory-core/src/store.ts:323-325`) and `listMemory` (`packages/memory-core/src/store.ts:398-399`) | Returns empty array `[]` immediately | Guarded in both functions |
| Trigram virtual table missing | SQLite throw during creation caught inside `trigramReady` | Sets WeakMap state to `false`; uses `scanRows` | `packages/memory-core/src/store.ts:63-74`, `packages/memory-core/src/store.ts:340` |
| Vector table missing or dimension mismatch | Guard checking `lane_pilot_memory_vec` table (`packages/memory-core/src/vectors.ts:24-31`) and dimension check in `denseRank` (`packages/memory-core/src/vectors.ts:84-88`) | `denseRank` returns `null`; search stays on words | Handled gracefully |
| Asynchronous embedding not awaited | `queryVectorFor(query)` returns `undefined` | `denseRows` returns `null`; search returns fused word/trigram rows | `packages/memory-core/src/store.ts:361-363`, `packages/memory-core/src/vectors.ts:110` |
| Held conflict exists | `heldClause` matches note ID against `lane_pilot_memory_conflict` | Record is excluded from SQL query results | `packages/memory-core/src/conflict-store.ts:62-65`, `packages/memory-core/src/store.ts:309` |

## Business rules

- Visibility conditions: a record is visible if and only if (`packages/memory-core/src/store.ts:305-311`):
  1. `status = 'active'`
  2. `valid_from IS NULL OR valid_from <= now`
  3. `valid_until IS NULL OR valid_until > now`
  4. It is not an idle note: `idleSql` (`packages/memory-core/src/lifecycle.ts:44-46`) excludes notes unused for `NOTE_IDLE_MS` (`packages/memory-core/src/lifecycle.ts:7-8`).
  5. It is confirmed trust or has survived `OBSERVED_QUARANTINE_MS` (`packages/memory-core/src/lifecycle.ts:5`), unless `options.includeObserved` is set (`packages/memory-core/src/store.ts:309`).
  6. It is not part of a held conflict (`packages/memory-core/src/conflict-store.ts:62-65`)
  7. Its section scope is project-wide or matches a prefix of the reader's section chain (`packages/memory-core/src/store.ts:292-296`, `packages/memory-core/src/store.ts:310`).
- Section chain resolution: a reader with chain `["section:a", "sub:b"]` can read scopes `[]`, `["section:a"]`, `["section:a", "sub:b"]`, or any scope containing `"project"` (`packages/memory-core/src/store.ts:292-296`, `packages/memory-core/src/store.ts:310`).
- Query token truncation: query tokens are deduplicated and capped at 32 entries to bound FTS query complexity (`packages/memory-core/src/store.ts:324`).

## Public API or commands

- `searchMemoryRecords(db, projectId, query, limit, engine, audience?, personalBot?, options?)`: primary search entry point (`packages/memory-core/src/store.ts:323-353`).
- `searchMemoryAllSections(db, projectId, query, limit, engine, audience?, personalBot?, options?)`: admin search crossing all sections (`packages/memory-core/src/store.ts:319-321`).
- `listMemory(db, projectId, filter, limit, audience?, personalBot?, options?)`: lists visible records filtered by kind or concepts (`packages/memory-core/src/store.ts:398-405`).
- `memoryVisibilitySql(db, alias, options)`: returns the SQL `WHERE` clause enforcing visibility rules (`packages/memory-core/src/store.ts:314-316`).
- `scopeValuesFor(chain: readonly string[])`: computes array of valid scope JSON strings for a section chain (`packages/memory-core/src/store.ts:292-296`).
- `projectUsesSections(db, projectId)`: detects if a project has runs utilizing section scopes (`packages/memory-core/src/store.ts:299-302`).

## Gotchas

- Omitting `options.chain` restricts retrieval to the project root scope (`[]`); an agent working in a section that forgets its chain will not see section-specific notes (`packages/memory-core/src/store.ts:285-288`, `packages/memory-core/src/store.ts:310`).
- Vector search is synchronous, but model embeddings are asynchronous; callers must invoke `rememberQueryVector` (`packages/memory-core/src/vectors.ts:105-109`) before calling `searchMemoryRecords` (`packages/memory-core/src/store.ts:323-326`), otherwise `denseRows` (`packages/memory-core/src/store.ts:360-363`) silently skips vector ranking.
- In SQLite databases older than 3.34 where the trigram tokenizer is unavailable, search falls back to in-memory substring scanning (`scanRows`), which loads all active records into process memory (`packages/memory-core/src/store.ts:56-75`, `packages/memory-core/src/store.ts:388-392`).
- Notes involved in held conflicts are excluded from search results without returning an error or warning to the caller (`packages/memory-core/src/conflict-store.ts:62-65`, `packages/memory-core/src/store.ts:309`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Memory core workspace overview](../overview.md)
