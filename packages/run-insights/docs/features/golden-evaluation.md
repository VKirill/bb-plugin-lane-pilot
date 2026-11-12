---
title: Golden retrieval evaluation
type: component
created: 2026-11-12
updated: 2026-11-12
status: active
confidence: low
tags: [run-insights, memory, retrieval, evaluation]
sources:
  - packages/run-insights/src/golden.ts
  - packages/run-insights/src/index.ts
---

# Golden retrieval evaluation

TL;DR: Golden cases list IDs a query must retrieve; evaluation reports hit rate and missing IDs.

## Purpose

`parseGoldenCases` accepts JSON or a lane-memory line form; `runGoldenEval` calls a supplied search function ([implementation](packages/run-insights/src/golden.ts:10-48)). Both functions are exported ([package API](packages/run-insights/src/index.ts:14)).

## How it works

1. Null, undefined, blank, and `[]` parse as no cases; JSON strings are parsed as JSON; other strings are parsed line by line ([source](packages/run-insights/src/golden.ts:14-25)).
2. Structured cases require a nonblank query and string array `mustHit`; IDs are deduplicated ([source](packages/run-insights/src/golden.ts:26-35)).
3. Search runs once per case. A hit requires every listed ID; report includes totals, rate, and misses ([source](packages/run-insights/src/golden.ts:37-48)).

## Modes

| Input | Behavior |
|---|---|
| Null, undefined, blank, `[]` | Empty set ([source](packages/run-insights/src/golden.ts:14-19)) |
| JSON string or array | Validates case shape; invalid cases throw ([source](packages/run-insights/src/golden.ts:19-35)) |
| Lines `- query -> id1, id2` | Matching lines parsed; nonmatching lines ignored ([source](packages/run-insights/src/golden.ts:20-24)) |
| Empty case list | Hit rate is 1 with zero cases ([source](packages/run-insights/src/golden.ts:38-48)) |

## Business rules

All expected IDs must be found for a hit; malformed structured input throws, while malformed lines are skipped ([source](packages/run-insights/src/golden.ts:20-46)).

## Public API or commands

Call `parseGoldenCases` and `runGoldenEval`; neither defines commands or database writes ([exports](packages/run-insights/src/index.ts:14), [evaluator](packages/run-insights/src/golden.ts:37-48)).

## Gotchas

The line parser silently skips malformed rows. Empty evaluation returns hit rate 1, so inspect `cases` too ([source](packages/run-insights/src/golden.ts:20-24), [report](packages/run-insights/src/golden.ts:38-48)).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Run insights gotchas](../gotchas.md)
- [Run insights](../overview.md)
