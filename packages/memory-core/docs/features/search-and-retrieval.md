---
title: Memory search and retrieval
type: component
created: 2026-11-07
updated: 2026-11-11
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

The search subsystem retrieves active project facts and rules matching natural language queries, keyword terms, or role concepts while enforcing tenant permissions, audience visibility, section isolation, and conflict exclusion (`packages/memory-core/src/store.ts:311-359`, `packages/memory-core/src/store.ts:404-411`).

## How it works

1. Query tokenization: `memoryTokens` extracts word tokens (alphanumeric, underscores, hyphens) of 3 or more characters; the search caps distinct tokens at 32 (`packages/memory-core/src/terms.ts:2-4`, `packages/memory-core/src/store.ts:330`).
2. FTS5 BM25 whole-word search: when `engine !== "bm25"`, queries the `lane_pilot_memory_fts` virtual table using SQLite `MATCH` with `OR` combinations, ordered by `bm25(lane_pilot_memory_fts)` (`packages/memory-core/src/store.ts:333-339`).
3. Trigram substring search: tokens are stemmed via `memoryStem` (stripping two letters from tokens >= 6 characters); if `trigramReady` succeeds, queries `lane_pilot_memory_trgm` via `MATCH` and `bm25()` (`packages/memory-core/src/terms.ts:10-12`, `packages/memory-core/src/store.ts:340-347`). If trigram FTS5 is unsupported, falls back to in-memory `scanRows` (`packages/memory-core/src/store.ts:346`, `packages/memory-core/src/store.ts:394-398`).
4. Reciprocal Rank Fusion: `fuse` merges the word and stem result lists using reciprocal rank scores: $\sum 1 / (60 + \text{rank} + 1)$, breaking ties by record creation time (`packages/memory-core/src/store.ts:347`, `packages/memory-core/src/store.ts:383-391`).
5. Dense vector re-ranking: `denseRows` inspects whether a precomputed query vector is registered in memory via `queryVectorFor` (`packages/memory-core/src/store.ts:366-368`, `packages/memory-core/src/vectors.ts:111`). If available:
   - Queries all vectored records for the project via `denseRank` (`packages/memory-core/src/vectors.ts:85-97`), computing the dot product with `unit` normalized vectors (`packages/memory-core/src/vectors.ts:56-61`).
   - Prioritizes lexical matches that contain path anchors named in the query (`packages/memory-core/src/store.ts:373-377`).
   - Appends visible records sorted by cosine similarity (`packages/memory-core/src/store.ts:378`).
   - Appends any remaining word matches that lack vector embeddings at the tail (`packages/memory-core/src/store.ts:379`).
6. Fallback BM25 scoring: if `engine === "bm25"`, queries all visible rows directly and scores each record by counting query token occurrences across `content` and `concepts_json` (`packages/memory-core/src/store.ts:350-354`).
7. Visibility enforcement: every search path applies `visibility`, ensuring rows meet active status, valid time window, non-idleness, trust quarantine, absence of held conflicts (`heldClause`), and section scope match (`packages/memory-core/src/store.ts:311-317`, `packages/memory-core/src/conflict-store.ts:62-65`).
8. Concept and kind listing: `listMemory` allows roles to retrieve visible records filtered by kind (`"core"` or `"note"`) and concept tags without requiring a text query, sorted by creation timestamp descending (`packages/memory-core/src/store.ts:404-411`).

## Modes, variants and branches

| Search mode / branch | Inputs and flags | Scoring and matching | Outputs and limits | Evidence |
|---|---|---|---|---|
| Auto / FTS5 (`engine !== "bm25"`) | Default search engine setting | FTS5 whole-word BM25 + FTS5 trigram BM25 fused via RRF | Returns top `limit` records | `packages/memory-core/src/store.ts:333-349` |
| In-code fallback scan | Triggered when SQLite lacks trigram tokenizer | In-code substring counting of stems across content and concepts | `scanRows` substituted into RRF fusion (`packages/memory-core/src/store.ts:346`, `packages/memory-core/src/store.ts:394-398`) | `packages/memory-core/src/store.ts:340-347` |
| Token frequency fallback | Engine option in `MEMORY_SEARCH_ENGINES` (`packages/memory-core/src/settings.ts:2, 62`) | Direct token frequency scoring (`_score`) against visible project rows | Scored and sorted in memory (`packages/memory-core/src/store.ts:350-354`) | Evaluates all visible rows |
| Dense semantic search | Caller registers vector via `rememberQueryVector` (`packages/memory-core/src/vectors.ts:106-110`) | `denseRows` (`packages/memory-core/src/store.ts:366-380`) re-ranks by `denseRank` (`packages/memory-core/src/vectors.ts:85-97`) | Records carry `.similarity` | Ranked by cosine |
| Standard search (`searchMemoryRecords`) | Standard working reader | Scoped to project root and reader's section chain (`options.chain`) | Excludes sibling sections | `packages/memory-core/src/store.ts:289-297, 329` |
| Admin search (`searchMemoryAllSections`) | Admin or maintenance query | `options.allSections = true` | Searches across all sections of the project | `packages/memory-core/src/store.ts:324-327` |
| Concept listing (`listMemory`) | Target `kind` and `concepts` array | Direct SQL filtering on `kind` and `concepts_json LIKE` | Newest visible records first | `packages/memory-core/src/store.ts:404-411` |

## Failure behavior

| Failure condition | Handling mechanism | Outcome | Evidence |
|---|---|---|---|
| Empty query or non-positive limit | Short-circuit guard in `searchMemoryRecords` (`packages/memory-core/src/store.ts:329-332`) and `listMemory` (`packages/memory-core/src/store.ts:404-406`) | Returns empty array `[]` immediately | Guarded in both functions |
| Trigram virtual table missing | SQLite throw during creation caught inside `trigramReady` | Sets WeakMap state to `false`; uses `scanRows` | `packages/memory-core/src/store.ts:60-75`, `packages/memory-core/src/store.ts:340-347` |
| Vector table missing or dimension mismatch | Guard checking `lane_pilot_memory_vec` table (`packages/memory-core/src/vectors.ts:24-31`) and dimension check in `denseRank` (`packages/memory-core/src/vectors.ts:85-88`) | `denseRank` returns `null`; search stays on words | Handled gracefully |
| Asynchronous embedding not awaited | `queryVectorFor(query)` returns `undefined` | `denseRows` returns `null`; search returns fused word/trigram rows | `packages/memory-core/src/store.ts:366-370`, `packages/memory-core/src/vectors.ts:111` |
| Held conflict exists | `heldClause` matches note ID against `lane_pilot_memory_conflict` | Record is excluded from SQL query results | `packages/memory-core/src/conflict-store.ts:62-67`, `packages/memory-core/src/store.ts:313-316` |

## Business rules

- Visibility conditions: a record is visible if and only if (`packages/memory-core/src/store.ts:311-317`):
  1. `status = 'active'`
  2. `valid_from IS NULL OR valid_from <= now`
  3. `valid_until IS NULL OR valid_until > now`
  4. It is not an idle note: `idleSql` (`packages/memory-core/src/lifecycle.ts:45-47`) excludes notes unused for `NOTE_IDLE_MS` (`packages/memory-core/src/lifecycle.ts:7`).
  5. It is confirmed trust or has survived `OBSERVED_QUARANTINE_MS` (`packages/memory-core/src/lifecycle.ts:5`), unless `options.includeObserved` is set (`packages/memory-core/src/store.ts:314-315`).
  6. It is not part of a held conflict (`packages/memory-core/src/conflict-store.ts:62-65`)
  7. Its section scope is project-wide or matches a prefix of the reader's section chain (`packages/memory-core/src/store.ts:298-304`, `packages/memory-core/src/store.ts:316`).
- Section chain resolution: a reader with chain `["section:a", "sub:b"]` can read scopes `[]`, `["section:a"]`, `["section:a", "sub:b"]`, or any scope containing `"project"` (`packages/memory-core/src/store.ts:298-304`, `packages/memory-core/src/store.ts:316`).
- Query token truncation: query tokens are deduplicated and capped at 32 entries to bound FTS query complexity (`packages/memory-core/src/store.ts:330`).

## Public API or commands

- `searchMemoryRecords(db, projectId, query, limit, engine, audience?, personalBot?, options?)`: primary search entry point (`packages/memory-core/src/store.ts:329-359`).
- `searchMemoryAllSections(db, projectId, query, limit, engine, audience?, personalBot?, options?)`: admin search crossing all sections (`packages/memory-core/src/store.ts:324-327`).
- `listMemory(db, projectId, filter, limit, audience?, personalBot?, options?)`: lists visible records filtered by kind or concepts (`packages/memory-core/src/store.ts:404-411`).
- `memoryVisibilitySql(db, alias, options)`: returns the SQL `WHERE` clause enforcing visibility rules (`packages/memory-core/src/store.ts:319-322`).
- `scopeValuesFor(chain: readonly string[])`: computes array of valid scope JSON strings for a section chain (`packages/memory-core/src/store.ts:298-304`).
- `projectUsesSections(db, projectId, hasScopedRun)`: evaluates if a project uses section scopes via caller-supplied `hasScopedRun` run predicate (`packages/memory-core/src/store.ts:305-308`).
- `coldMemoryRows(db, input)`: queries idle-expired or owner-archived note rows for one project's cold-tier read (`packages/memory-core/src/store.ts:499-507`).
- `reactivateColdMemory(db, projectId, id, now)`: re-activates one cold-tier note to active status (`packages/memory-core/src/store.ts:508-513`).
- `recordMemoryPromotion(db, projectId, memoryId, query, now)`: logs a promotion row on reactivation (`packages/memory-core/src/store.ts:513-517`).
- `listIdlePromotions(db, beforeMs)`: lists notes re-activated by promotion that remained idle past the threshold (`packages/memory-core/src/store.ts:518-523`).
- `expireIdleMemory(db, id)`: marks a still-active note expired with `expired_reason = 'idle'` (`packages/memory-core/src/store.ts:524-528`).
- `recordMemoryMiss(db, projectId, query, now)`: records a search query that yielded no results (`packages/memory-core/src/store.ts:693-698`).
- `listMemoryMisses(db, sinceMs, projectId?, limit?)`: returns latest search misses since a timestamp (`packages/memory-core/src/store.ts:539-548`).
- `countColdMemories(db, projectId?)`: counts cold-tier notes (`packages/memory-core/src/store.ts:529-533`).
- `countMemoryPromotions(db, projectId?)`: counts distinct promoted notes (`packages/memory-core/src/store.ts:534-538`).

## Gotchas

- Omitting `options.chain` restricts retrieval to the project root scope (`[]`); an agent working in a section that forgets its chain will not see section-specific notes (`packages/memory-core/src/store.ts:289-295`, `packages/memory-core/src/store.ts:316`).
- Vector search is synchronous, but model embeddings are asynchronous; callers must invoke `rememberQueryVector` (`packages/memory-core/src/vectors.ts:106-110`) before calling `searchMemoryRecords` (`packages/memory-core/src/store.ts:329-332`), otherwise `denseRows` (`packages/memory-core/src/store.ts:366-370`) silently skips vector ranking.
- In SQLite databases older than 3.34 where the trigram tokenizer is unavailable, search falls back to in-memory substring scanning (`scanRows`), which loads all visible records into process memory (`packages/memory-core/src/store.ts:60-75`, `packages/memory-core/src/store.ts:394-398`).
- Notes involved in held conflicts are excluded from search results without returning an error or warning to the caller (`packages/memory-core/src/conflict-store.ts:62-67`, `packages/memory-core/src/store.ts:313-316`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Memory core workspace overview](../overview.md)
