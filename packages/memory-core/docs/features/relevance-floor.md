---
title: Memory relevance floor
type: component
created: 2026-11-07
updated: 2026-11-07
status: active
confidence: medium
tags: [memory, floor, relevance, idf, vectors, filtering]
sources:
  - packages/memory-core/src/floor.ts
  - packages/memory-core/src/terms.ts
  - packages/memory-core/src/settings.ts
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/vectors.ts
  - src/rooms/memory-eval/server/retrievers.ts
  - src/rooms/memory-eval/server/floor-tuning.ts
  - src/rooms/writer/server/writer-knowledge.ts
  - src/rooms/council/server/council.ts
---

# Memory relevance floor

TL;DR: The relevance floor cuts off weakly matching records using question-length-interpolated word weights, path anchor overrides, and dense vector similarity thresholds.

## Purpose

The relevance floor filters retrieved search results so that questions having negligible connection to project memory return no notes rather than injecting distantly related noise into agent prompts (`packages/memory-core/src/floor.ts:5-18`, `packages/memory-core/src/floor.ts:31-35`).

## How it works

1. Stemming question terms: extracts alphanumeric tokens >= 4 characters from the query string and stems them via `memoryStem` into a unique set (`packages/memory-core/src/floor.ts:38`).
2. Counting question length: counts distinct stems in the query via `questionWords` (`packages/memory-core/src/floor.ts:41`).
3. Extracting path anchors: `pathAnchorsOf` scans the query for file path segments, keeping the last two segments of each path (for example `dir/file.ts` from `src/dir/file.ts`) (`packages/memory-core/src/floor.ts:44-51`).
4. Computing corpus word frequencies: `wordFrequencies` queries the active records of the project, audience, and personal bot, caching document counts per stem in a `WeakMap` keyed on record count, max creation time, and total text size (`packages/memory-core/src/floor.ts:54-72`).
5. Calculating inverse document weight: `recordRelevance` computes the weight of each shared stem between query and record content as:
   $$\text{weight}(\text{stem}) = \frac{\ln(1 + \frac{N}{\max(1, n_{\text{stem}})})}{\ln(1 + N)}$$
   where $N$ is total active records and $n_{\text{stem}}$ is the number of records containing that stem (`packages/memory-core/src/floor.ts:78-89`).
6. Threshold interpolation: `floorThreshold` computes the score target based on question distinct word count, interpolating between `minScoreShort` and `minScore` (`packages/memory-core/src/floor.ts:96-99`).
7. Evaluating lexical clearance: `clearsFloor` grants admission if `floor.anchor` is enabled and the record text matches a query path anchor, or if total shared stem weight reaches `floorThreshold` (`packages/memory-core/src/floor.ts:108-109`).
8. Evaluating dense vector clearance: for records carrying a vector cosine similarity score, `relevantRecords` checks if `similarity >= DENSE_FLOOR` (0.65) or if the record matches a path anchor (`packages/memory-core/src/floor.ts:106`, `packages/memory-core/src/floor.ts:117-119`).
9. Returning cleared records: `relevantRecords` preserves original ranking order for records passing the floor; if no records qualify, callers fall back to the explicit `NOTHING_RELEVANT` message (`packages/memory-core/src/floor.ts:34-35`, `packages/memory-core/src/floor.ts:112-120`).

## Modes, variants and branches

| Search type / branch | Inputs and conditions | Evaluation logic | Clearance criteria | Evidence |
|---|---|---|---|---|
| Short query (< 12 distinct stems) | Short task title or brief query | Threshold scales towards `minScoreShort = 0` | Low score required; short questions cannot match random words by chance | `packages/memory-core/src/floor.ts:31, 96-99` |
| Long query (>= 17 distinct stems) | Full task description or bug report | Threshold capped at `minScore = 2.0` | Higher cumulative weight required to avoid accidental overlap | `packages/memory-core/src/floor.ts:31, 96-99` |
| Intermediate query (12 to 17 stems) | Medium length query | Linear interpolation between 0 and 2.0 | Proportional threshold | `packages/memory-core/src/floor.ts:96-99` |
| Path anchor match | Query and record both contain identical `dir/file.ts` segment | `anchor = true` | Clears floor unconditionally regardless of score | `packages/memory-core/src/floor.ts:27, 90, 108` |
| Dense vector record | Record carries `.similarity` from `vectors.ts` | Checked against `DENSE_FLOOR = 0.65` | `similarity >= 0.65` or path anchor match | `packages/memory-core/src/floor.ts:106, 117-119` |
| Floor bypassed | `floor: null` passed in options | Bypasses calculations | Returns all candidate records unchanged | `packages/memory-core/src/floor.ts:113-114` |

## Failure behavior

| Condition | Failure mode | Result | Evidence |
|---|---|---|---|
| No records clear floor | All retrieved records fail threshold and lack anchors | Returns empty array `[]` | `packages/memory-core/src/floor.ts:117-120` |
| Caller receives empty filtered list | Downstream session or PM tool consumes result | Emits `NOTHING_RELEVANT` string | `packages/memory-core/src/floor.ts:34-35` |
| No active records in project | `frequencies.total === 0` | `total` clamped to 1; returns empty relevance map | `packages/memory-core/src/floor.ts:78` |
| Query contains no valid tokens | `stemsOf(query)` yields empty set | Words count is 0; scores evaluate to 0 | `packages/memory-core/src/floor.ts:38, 41` |

## Business rules

- Default parameters: `DEFAULT_RELEVANCE_FLOOR` defines `minScore: 2`, `minScoreShort: 0`, `shortWords: 12`, `longWords: 17`, and `anchor: true` (`packages/memory-core/src/floor.ts:31`).
- Dense vector cutoff: `DENSE_FLOOR` is fixed at `0.65` cosine similarity for 768-dimensional embeddings (`packages/memory-core/src/floor.ts:106`).
- Stem length requirement: tokens under 4 characters are excluded from word frequency and relevance calculations to prevent stop-word noise (`packages/memory-core/src/floor.ts:38`).
- Path anchor specificity: path anchors require at least two path segments (`parts.length >= 2`), matching `sub/file.ts` rather than bare file names or root directories (`packages/memory-core/src/floor.ts:47-49`).
- Nothing relevant contract: when no records clear the floor, downstream callers must inform the agent using `NOTHING_RELEVANT` ("Memory has nothing relevant to this query. Do not assume or invent project facts; read the code or ask the owner.") (`packages/memory-core/src/floor.ts:34-35`).

## Public API or commands

- `relevantRecords(db, projectId, query, records, opts?)`: filters an array of records using the configured relevance floor (`packages/memory-core/src/floor.ts:112-120`).
- `clearsFloor(relevance, floor, words)`: checks if a single record's relevance score satisfies the floor (`packages/memory-core/src/floor.ts:108-109`).
- `floorThreshold(floor, words)`: computes dynamic score threshold for a given query word count (`packages/memory-core/src/floor.ts:96-99`).
- `recordRelevance(frequencies, query, records)`: calculates shared words, cumulative weight, and anchor flags for each record (`packages/memory-core/src/floor.ts:75-93`).
- `wordFrequencies(db, projectId, audience, personalBot)`: computes or retrieves cached stem frequencies across active records (`packages/memory-core/src/floor.ts:57-72`).
- `pathAnchorsOf(text)`: extracts two-segment file paths from a string (`packages/memory-core/src/floor.ts:44-51`).
- `questionWords(query)`: counts distinct stems >= 4 characters in a query (`packages/memory-core/src/floor.ts:41`).

## Gotchas

- Vector similarity floor `DENSE_FLOOR = 0.65` (`packages/memory-core/src/floor.ts:106`) cuts off noisy semantic matches, but because questions with no project answer often find an irrelevant record scoring above 0.65, vector filtering alone cannot guarantee answer existence; downstream re-ranking must confirm sufficiency (`packages/memory-core/src/floor.ts:102-106`).
- The frequency cache uses a `WeakMap` keyed on the SQLite database handle; creating new database connection instances on each query bypasses the cache and re-scans all active rows (`packages/memory-core/src/floor.ts:54-62`).
- An exact path anchor match overrides score thresholds entirely; a note naming `src/database.ts` will clear the floor on any query mentioning `src/database.ts`, even if the rest of the text has no word overlap (`packages/memory-core/src/floor.ts:108-109`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Memory core workspace overview](../overview.md)
