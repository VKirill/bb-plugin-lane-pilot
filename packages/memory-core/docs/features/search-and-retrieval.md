---
title: Memory search and retrieval
type: component
created: 2026-11-07
updated: 2026-11-15
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
  - packages/memory-core/src/index.ts
  - src/rooms/memory/server/session-memory.ts
---

# Memory search and retrieval

TL;DR: Search merges whole-word BM25 hits, trigram substring matches, and dense vector rankings with section scoping and visibility filters.

## Purpose

The search subsystem retrieves active project facts and rules matching natural language queries, keyword terms, or role concepts while enforcing tenant permissions, audience visibility, section isolation, and conflict exclusion (`packages/memory-core/src/store.ts:346-430`, `packages/memory-core/src/store.ts:542-549`).

## How it works

1. Query tokenization: `memoryTokens` extracts word tokens (alphanumeric, underscores, hyphens) of 3 or more characters; the search caps distinct tokens at 32 (`packages/memory-core/src/terms.ts:2-4`, `packages/memory-core/src/store.ts:411`).
2. FTS5 BM25 whole-word search: when `engine !== "bm25"`, queries the `lane_pilot_memory_fts` virtual table using SQLite `MATCH` with `OR` combinations, ordered by `bm25(lane_pilot_memory_fts)` (`packages/memory-core/src/store.ts:414, 438-442`).
3. Trigram substring search: tokens are stemmed via `memoryStem` (stripping two letters from tokens >= 6 characters); if `trigramReady` succeeds, queries `lane_pilot_memory_trgm` via `MATCH` and `bm25()` (`packages/memory-core/src/terms.ts:10-12`, `packages/memory-core/src/store.ts:64-80, 444-451`). If trigram FTS5 is unsupported, falls back to in-memory `scanRows` (`packages/memory-core/src/store.ts:450`, `packages/memory-core/src/store.ts:532-536`).
4. Reciprocal Rank Fusion: `fuse` merges the word and stem result lists using reciprocal rank scores: $\sum 1 / (60 + \text{rank} + 1)$, breaking ties by record creation time (`packages/memory-core/src/store.ts:452`, `packages/memory-core/src/store.ts:522-529`).
5. Dense vector re-ranking: `denseRows` inspects whether a precomputed query vector is registered in memory via `queryVectorFor` (`packages/memory-core/src/store.ts:503-506`, `packages/memory-core/src/vectors.ts:186`). If available:
   - Queries all vectored records for the project via `denseRank` (`packages/memory-core/src/vectors.ts:153-172`), computing the dot product with `unit` normalized vectors (`packages/memory-core/src/vectors.ts:120-125`).
   - Prioritizes lexical matches that contain path anchors named in the query (`packages/memory-core/src/store.ts:511-515`).
   - Appends visible records sorted by cosine similarity (`packages/memory-core/src/store.ts:516`).
   - Appends any remaining word matches that lack vector embeddings at the tail (`packages/memory-core/src/store.ts:517`).
6. Fallback BM25 scoring: if `engine === "bm25"`, queries all visible rows directly and scores each record by counting query token occurrences across `content` and `concepts_json` (`packages/memory-core/src/store.ts:421-425`).
7. Visibility enforcement: every search path applies `visibility`, ensuring rows meet active status, valid time window, non-idleness, trust quarantine, absence of held conflicts (`heldClause`), and section scope match (`packages/memory-core/src/store.ts:346-354`, `packages/memory-core/src/conflict-store.ts:62-65`).
8. Concept and kind listing: `listMemory` allows roles to retrieve visible records filtered by kind (`"core"` or `"note"`) and concept tags without requiring a text query, sorted by creation timestamp descending (`packages/memory-core/src/store.ts:542-549`).

## Modes, variants and branches

| Search mode / branch | Inputs and flags | Scoring and matching | Outputs and limits | Evidence |
|---|---|---|---|---|
| Auto / FTS5 (`engine !== "bm25"`) | Default search engine setting | FTS5 whole-word BM25 + FTS5 trigram BM25 fused via RRF | Returns top `limit` records | `packages/memory-core/src/store.ts:414-420, 436-453` |
| In-code fallback scan | Triggered when SQLite lacks trigram tokenizer | In-code substring counting of stems across content and concepts | `scanRows` substituted into RRF fusion (`packages/memory-core/src/store.ts:450`, `packages/memory-core/src/store.ts:532-536`) | `packages/memory-core/src/store.ts:444-453` |
| Token frequency fallback | Engine option in `MEMORY_SEARCH_ENGINES` (`packages/memory-core/src/settings.ts:2, 79`) | Direct token frequency scoring (`_score`) against visible project rows | Scored and sorted in memory (`packages/memory-core/src/store.ts:421-425`) | Evaluates all visible rows |
| Dense semantic search | Caller registers vector via `rememberQueryVector` (`packages/memory-core/src/vectors.ts:181-185`) | `denseRows` (`packages/memory-core/src/store.ts:503-519`) re-ranks by `denseRank` (`packages/memory-core/src/vectors.ts:153-172`) | Records carry `.similarity` | Ranked by cosine |
| Standard search (`searchMemoryRecords`) | Standard working reader | Scoped to project root and reader's section chain (`options.chain`) | Excludes sibling sections | `packages/memory-core/src/store.ts:316-320, 353, 409` |
| Admin search (`searchMemoryAllSections`) | Admin or maintenance query | `options.allSections = true` | Searches across all sections of the project | `packages/memory-core/src/store.ts:405-407` |
| Concept listing (`listMemory`) | Target `kind` and `concepts` array | Direct SQL filtering on `kind` and `concepts_json LIKE` | Newest visible records first | `packages/memory-core/src/store.ts:542-549` |

## Failure behavior

| Failure condition | Handling mechanism | Outcome | Evidence |
|---|---|---|---|
| Empty query or non-positive limit | Short-circuit guard in `searchMemoryRecords` (`packages/memory-core/src/store.ts:409-412`) and `listMemory` (`packages/memory-core/src/store.ts:542-543`) | Returns empty array `[]` immediately | Guarded in both functions |
| Trigram virtual table missing | SQLite throw during creation caught inside `trigramReady` | Sets `WeakMap` state to `false` outside a transaction (left uncached when `inTransaction` is true); uses `scanRows` | `packages/memory-core/src/store.ts:57, 64-80`, `packages/memory-core/src/store.ts:445-451` |
| Vector table missing or dimension mismatch | Guard checking `lane_pilot_memory_vec` table (`packages/memory-core/src/vectors.ts:19-35`) and dimension check in `denseRank` (`packages/memory-core/src/vectors.ts:153-156`) | `denseRank` returns `null`; search stays on words | Handled gracefully |
| Asynchronous embedding not awaited | `queryVectorFor(query)` returns `undefined` | `denseRows` returns `null`; search returns fused word/trigram rows | `packages/memory-core/src/store.ts:503-506`, `packages/memory-core/src/vectors.ts:186` |
| Held conflict exists | `heldClause` matches note ID against `lane_pilot_memory_conflict` | Record is excluded from SQL query results | `packages/memory-core/src/conflict-store.ts:62-65`, `packages/memory-core/src/store.ts:352` |

## Business rules

- Visibility conditions: a record is visible if and only if (`packages/memory-core/src/store.ts:346-354`):
  1. `status = 'active'`
  2. `valid_from IS NULL OR valid_from <= now`
  3. `valid_until IS NULL OR valid_until > now`
  4. It is not an idle note: `idleSql` (`packages/memory-core/src/lifecycle.ts:46-48`) excludes notes unused for `NOTE_IDLE_MS` (`packages/memory-core/src/lifecycle.ts:8`).
  5. It is confirmed trust or has survived `OBSERVED_QUARANTINE_MS` (`packages/memory-core/src/lifecycle.ts:6`), unless `options.includeObserved` is set (`packages/memory-core/src/store.ts:352`).
  6. It is not part of a held conflict (`packages/memory-core/src/conflict-store.ts:62-65`)
  7. Its section scope is project-wide or matches a prefix of the reader's section chain (`packages/memory-core/src/store.ts:333-337`, `packages/memory-core/src/store.ts:353`).
- Section chain resolution: a reader with chain `["section:a", "sub:b"]` can read scopes `[]`, `["section:a"]`, `["section:a", "sub:b"]`, or any scope containing `"project"` (`packages/memory-core/src/store.ts:333-337`, `packages/memory-core/src/store.ts:353`).
- Query token truncation: query tokens are deduplicated and capped at 32 entries to bound FTS query complexity (`packages/memory-core/src/store.ts:411`).

## Public API or commands

- `searchMemoryRecords(db, projectId, query, limit, engine, audience?, personalBot?, options?)`: primary search entry point (`packages/memory-core/src/store.ts:409-430`).
- `searchMemoryAllSections(db, projectId, query, limit, engine, audience?, personalBot?, options?)`: admin search crossing all sections (`packages/memory-core/src/store.ts:405-407`).
- `listMemory(db, projectId, filter, limit, audience?, personalBot?, options?)`: lists visible records filtered by kind or concepts (`packages/memory-core/src/store.ts:542-549`).
- `memoryVisibilitySql(db, alias, options)`: returns the SQL `WHERE` clause enforcing visibility rules (`packages/memory-core/src/store.ts:357-359`).
- `scopeValuesFor(chain: readonly string[])`: computes array of valid scope JSON strings for a section chain (`packages/memory-core/src/store.ts:333-337`).
- `projectUsesSections(db, projectId, hasScopedRun)`: evaluates if a project uses section scopes via caller-supplied `hasScopedRun` run predicate (`packages/memory-core/src/store.ts:340-343`).
- `coldMemoryRows(db, input)`: queries idle-expired or owner-archived note rows for one project's cold-tier read (`packages/memory-core/src/store.ts:642-645`).
- `reactivateColdMemory(db, projectId, id, now)`: re-activates one cold-tier note to active status (`packages/memory-core/src/store.ts:648-650`).
- `recordMemoryPromotion(db, projectId, memoryId, query, now)`: logs a promotion row on reactivation (`packages/memory-core/src/store.ts:653-655`).
- `listIdlePromotions(db, beforeMs)`: lists notes re-activated by promotion that remained idle past the threshold (`packages/memory-core/src/store.ts:658-661`).
- `expireIdleMemory(db, id)`: marks a still-active note expired with `expired_reason = 'idle'` (`packages/memory-core/src/store.ts:664-666`).
- `recordMemoryMiss(db, projectId, query, now)`: records a search query that yielded no results (`packages/memory-core/src/store.ts:770-774`).
- `listMemoryMisses(db, sinceMs, projectId?, limit?)`: returns latest search misses since a timestamp (`packages/memory-core/src/store.ts:679-686`).
- `countColdMemories(db, projectId?)`: counts cold-tier notes (`packages/memory-core/src/store.ts:669-671`).
- `countMemoryPromotions(db, projectId?)`: counts distinct promoted notes (`packages/memory-core/src/store.ts:674-676`).

## Gotchas

- Omitting `options.chain` restricts retrieval to the project root scope (`[]`); an agent working in a section that forgets its chain will not see section-specific notes (`packages/memory-core/src/store.ts:316-320, 353`).
- Vector search is synchronous, but model embeddings are asynchronous; callers must invoke `rememberQueryVector` (`packages/memory-core/src/vectors.ts:181-185`) before calling `searchMemoryRecords` (`packages/memory-core/src/store.ts:409-412`), otherwise `denseRows` (`packages/memory-core/src/store.ts:503-506`) silently skips vector ranking.
- In SQLite databases older than 3.34 where the trigram tokenizer is unavailable, search falls back to in-memory substring scanning (`scanRows`), which loads all visible records into process memory (`packages/memory-core/src/store.ts:64-80`, `packages/memory-core/src/store.ts:532-536`). Because `trigramReady` only caches its result in `trigramState` when `db.inTransaction` is falsy (`packages/memory-core/src/store.ts:57, 77-78`), a first call inside a rolled-back transaction (such as a dry-run import) does not leave the index cached as ready.
- Notes involved in held conflicts are excluded from search results without returning an error or warning to the caller (`packages/memory-core/src/conflict-store.ts:62-65`, `packages/memory-core/src/store.ts:352`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Memory core workspace overview](../overview.md)
