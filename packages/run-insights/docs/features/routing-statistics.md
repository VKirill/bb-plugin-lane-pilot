---
title: Writer routing statistics
type: component
created: 2026-11-12
updated: 2026-11-12
status: active
confidence: low
tags: [run-insights, writer, routing, statistics]
sources:
  - packages/run-insights/src/routing-stats.ts
  - packages/run-insights/src/index.ts
---

# Writer routing statistics

TL;DR: Functions derive acceptance counts by provider, model, and task risk, then recommend a pair or format a settings hint.

## Purpose

The caller supplies a database-like object with `prepare`; this feature reads writer receipts, acceptance receipts, runs, and task contracts ([database type](packages/run-insights/src/routing-stats.ts:1-4), [query](packages/run-insights/src/routing-stats.ts:39-49)). Public exports are `writerAcceptanceStats`, `recommendWriter`, and `routingHint` ([exports](packages/run-insights/src/index.ts:1-8)).

## How it works

1. Select writer-agent receipts with provider and model, join to run and task, then left-join the acceptance receipt ([query](packages/run-insights/src/routing-stats.ts:39-49)).
2. Read risk from `contract_json`; missing, invalid, or empty risk becomes `unknown`. Group by provider/model/risk ([risk parsing](packages/run-insights/src/routing-stats.ts:25-32), [grouping](packages/run-insights/src/routing-stats.ts:50-58)).
3. Count each selected writer receipt as a task. Passed acceptance increments accepted; attempt `<=1` also increments first-try. Failed/blocked acceptance increments failed ([aggregation](packages/run-insights/src/routing-stats.ts:56-67)).
4. Recommend the highest first-try rate for a requested risk among rows meeting the minimum sample size. `routingHint` formats a comparison or returns empty text when none qualify ([recommendation](packages/run-insights/src/routing-stats.ts:72-83), [hint](packages/run-insights/src/routing-stats.ts:88-101)).

## Modes

| Function | Inputs and defaults | Output |
|---|---|---|
| `writerAcceptanceStats` | Optional `projectId`, `since`; no default date bound | Rows of provider/model/risk with counts ([source](packages/run-insights/src/routing-stats.ts:34-67)) |
| `recommendWriter` | Risk; `minTasks` defaults to 5 | Best pair or `null`; ties favor more tasks ([source](packages/run-insights/src/routing-stats.ts:72-84)) |
| `routingHint` | Stats, current pair or null, risk, minimum defaults to 5 | Sentence or empty string ([source](packages/run-insights/src/routing-stats.ts:88-101)) |

## Business rules

- A writer receipt without provider/model is omitted ([query](packages/run-insights/src/routing-stats.ts:39-49)).
- Missing acceptance remains in `tasks` but not accepted/failed ([aggregation](packages/run-insights/src/routing-stats.ts:56-65)).
- Attempt values 0 and 1 both count as first try ([source](packages/run-insights/src/routing-stats.ts:60-63)).

## Public API or commands

Use the three functions exported at package root; no commands are defined ([exports](packages/run-insights/src/index.ts:1-8)).

## Gotchas

`tasks` counts selected writer-receipt rows, not distinct task IDs. Malformed contracts silently enter the `unknown` risk group ([query and count](packages/run-insights/src/routing-stats.ts:25-31), [aggregation](packages/run-insights/src/routing-stats.ts:44-60)).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Run insights](../overview.md)
