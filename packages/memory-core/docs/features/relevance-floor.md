---
title: Memory relevance floor
type: component
created: 2026-11-07
updated: 2026-11-13
status: active
confidence: medium
tags: [memory, floor, relevance, idf, vectors, filtering]
sources:
  - packages/memory-core/src/floor.ts
  - packages/memory-core/src/index.ts
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

TL;DR: The relevance floor filters weak matches; a separate answer check can flag low-confidence meaning searches while keeping their notes available.

## Purpose

The relevance floor filters retrieved search results by lexical weight, path anchors, or dense similarity. The answer check is separate: it marks some meaning searches as weak but does not remove their records (`packages/memory-core/src/floor.ts:134-164`).

## How it works

1. Stemming question terms: extracts alphanumeric tokens >= 4 characters from the query string and stems them via `memoryStem` into a unique set (`packages/memory-core/src/floor.ts:38`).
2. Counting question length: counts distinct stems in the query via `questionWords` (`packages/memory-core/src/floor.ts:41`).
3. Extracting path anchors: `pathAnchorsOf` scans the query for file path segments, keeping the last two segments of each path (for example `dir/file.ts` from `src/dir/file.ts`) (`packages/memory-core/src/floor.ts:44-51`).
4. Computing corpus word frequencies: `wordFrequencies` queries the active records of the project, audience, and personal bot, caching document counts per stem in a `WeakMap` keyed on record count, max creation time, and total text size (`packages/memory-core/src/floor.ts:54-72`).
5. Calculating inverse document weight: `recordRelevance` computes the weight of each shared stem between query and record content as:
   $$\text{weight}(\text{stem}) = \frac{\ln(1 + \frac{N}{\max(1, n_{\text{stem}})})}{\ln(1 + N)}$$
   where $N$ is total active records and $n_{\text{stem}}$ is the number of records containing that stem (`packages/memory-core/src/floor.ts:75-90`).
6. Threshold interpolation: `floorThreshold` computes the score target based on question distinct word count, interpolating between `minScoreShort` and `minScore` (`packages/memory-core/src/floor.ts:96-99`).
7. Evaluating lexical clearance: `clearsFloor` grants admission if `floor.anchor` is enabled and the record text matches a query path anchor, or if total shared stem weight reaches `floorThreshold` (`packages/memory-core/src/floor.ts:134-135`).
8. Evaluating dense vector clearance: for records carrying a vector cosine similarity score, `relevantRecords` checks if `similarity >= DENSE_PREFILTER` (0.50) or if the record matches a path anchor (`packages/memory-core/src/floor.ts:106, 162-164`).
9. Answer confidence: `weakAnswer` evaluates the search results before floor filtering. It returns `false` when the floor is disabled, the list is empty, an enabled path anchor matches, or the answer probability cannot be calculated; it returns `true` below `ANSWER_GATE.min` (`packages/memory-core/src/floor.ts:119-153`).
10. Returning floor matches: `relevantRecords` preserves input order for records passing the lexical or vector floor. The answer check does not change that list (`packages/memory-core/src/floor.ts:156-164`).

## Modes, variants and branches

| Search type / branch | Inputs and conditions | Evaluation logic | Clearance criteria | Evidence |
|---|---|---|---|---|
| Short query (< 12 distinct stems) | Short task title or brief query | Threshold scales towards `minScoreShort = 0` | Low score required; short questions cannot match random words by chance | `packages/memory-core/src/floor.ts:31, 96-99` |
| Long query (>= 17 distinct stems) | Full task description or bug report | Threshold capped at `minScore = 2.0` | Higher cumulative weight required to avoid accidental overlap | `packages/memory-core/src/floor.ts:31, 96-99` |
| Intermediate query (12 to 17 stems) | Medium length query | Linear interpolation between 0 and 2.0 | Proportional threshold | `packages/memory-core/src/floor.ts:96-99` |
| Path anchor match | Query and record both contain identical `dir/file.ts` segment | `anchor = true` | Clears floor unconditionally regardless of score | `packages/memory-core/src/floor.ts:27, 90, 134-135` |
| Dense vector record | Record carries `.similarity` from `vectors.ts` | Checked against `DENSE_PREFILTER = 0.50` | `similarity >= 0.50` or path anchor match | `packages/memory-core/src/floor.ts:106, 162-164` |
| Floor bypassed | `floor: null` passed in options | Bypasses calculations | Returns all candidate records unchanged | `packages/memory-core/src/floor.ts:157-159` |
| Weak answer check | At least three meaning-ranked records, enabled floor, no matching path anchor | Logistic probability over similarity and lexical weights | Returns a boolean; does not filter records | `packages/memory-core/src/floor.ts:117-153` |

## Failure behavior

| Condition | Failure mode | Result | Evidence |
|---|---|---|---|
| No records clear floor | All retrieved records fail threshold and lack anchors | Returns empty array `[]` | `packages/memory-core/src/floor.ts:162-164` |
| Weak answer check has too few meaning-ranked records | `answerProbability` has fewer than three records with similarity | Returns `null`; `weakAnswer` returns `false` | `packages/memory-core/src/floor.ts:119-123, 147-153` |
| No active records in project | `frequencies.total === 0` | `total` clamped to 1; returns empty relevance map | `packages/memory-core/src/floor.ts:78` |
| Query contains no valid tokens | `stemsOf(query)` yields empty set | Words count is 0; scores evaluate to 0 | `packages/memory-core/src/floor.ts:38, 41` |

## Business rules

- Default parameters: `DEFAULT_RELEVANCE_FLOOR` defines `minScore: 2`, `minScoreShort: 0`, `shortWords: 12`, `longWords: 17`, and `anchor: true` (`packages/memory-core/src/floor.ts:31`).
- Dense vector cutoff: `DENSE_PREFILTER` is fixed at `0.50` cosine similarity for 768-dimensional embeddings (a safety pre-filter; the former 0.65 floor lost 21.6% of the answering sessions on LongMemEval) (`packages/memory-core/src/floor.ts:106`).
- Stem length requirement: tokens under 4 characters are excluded from word frequency and relevance calculations to prevent stop-word noise (`packages/memory-core/src/floor.ts:38`).
- Path anchor specificity: path anchors require at least two path segments (`parts.length >= 2`), matching `sub/file.ts` rather than bare file names or root directories (`packages/memory-core/src/floor.ts:44-52`).
- Weak answer signal: `weakAnswer` returns whether the unfiltered search probability is below `ANSWER_GATE.min` (`0.25`); it leaves the result list untouched. Nothing shown to a reader depends on it since 2026-11-13 (the `WEAK_MATCH` line is gone); `gateScore` keeps the probability for the judge's receipt (`packages/memory-core/src/floor.ts`).

## Public API or commands

- `relevantRecords(db, projectId, query, records, opts?)`: filters an array of records using the configured relevance floor (`packages/memory-core/src/floor.ts:156-164`).
- `weakAnswer(db, projectId, query, records, opts?)`: flags a low-confidence meaning search without filtering its records (`packages/memory-core/src/floor.ts:144-154`).
- `answerProbability(records, relevance)`: calculates the answer probability for up to 40 similarity-ranked records, or returns `null` when fewer than three have similarity scores (`packages/memory-core/src/floor.ts:119-132`).
- `gateScore(db, projectId, query, records, opts?)`: the gate's probability, for receipts only (`packages/memory-core/src/floor.ts`).
- `clearsFloor(relevance, floor, words)`: checks if a single record's relevance score satisfies the floor (`packages/memory-core/src/floor.ts:134-135`).
- `floorThreshold(floor, words)`: computes dynamic score threshold for a given query word count (`packages/memory-core/src/floor.ts:96-99`).
- `recordRelevance(frequencies, query, records)`: calculates shared words, cumulative weight, and anchor flags for each record (`packages/memory-core/src/floor.ts:75-93`).
- `wordFrequencies(db, projectId, audience, personalBot)`: computes or retrieves cached stem frequencies across active records (`packages/memory-core/src/floor.ts:57-72`).
- `pathAnchorsOf(text)`: extracts two-segment file paths from a string (`packages/memory-core/src/floor.ts:44-51`).
- `questionWords(query)`: counts distinct stems >= 4 characters in a query (`packages/memory-core/src/floor.ts:41`).

## Gotchas

- `weakAnswer` only evaluates searches with at least three similarity-scored records; lexical-only and smaller results do not receive a weak-answer signal (`packages/memory-core/src/floor.ts:119-123, 147-153`).
- The frequency cache uses a `WeakMap` keyed on the SQLite database handle; creating new database connection instances on each query bypasses the cache and re-scans all active rows (`packages/memory-core/src/floor.ts:54-62`).
- An exact path anchor match overrides score thresholds entirely; a note naming `src/database.ts` will clear the floor on any query mentioning `src/database.ts`, even if the rest of the text has no word overlap (`packages/memory-core/src/floor.ts:134-135`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Memory core workspace overview](../overview.md)
