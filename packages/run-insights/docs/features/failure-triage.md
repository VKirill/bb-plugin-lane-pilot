---
title: Failure triage
type: component
created: 2026-11-12
updated: 2026-11-12
status: active
confidence: low
tags: [run-insights, triage, failures]
sources:
  - packages/run-insights/src/triage.ts
  - packages/run-insights/src/index.ts
  - src/rooms/self-repair/server/rule-scan.ts
  - src/rooms/self-repair/server/collect.ts
---

# Failure triage

TL;DR: Triage prepares failure context, settles selected ownership-gate facts in code, stores classifications per attempt, and groups writer mistakes.

## Purpose

Exports cover triage questions/state, deterministic verdicts, persistence, and summaries ([exports](packages/run-insights/src/index.ts:74-115)). Host self-repair scan and collection code calls them ([scan](src/rooms/self-repair/server/rule-scan.ts:8-31), [collector](src/rooms/self-repair/server/collect.ts:6)).

## How it works

1. Caller provides attempt, run, task, contract JSON, reason, and failure time; the state builder parses the contract and extracts its fields ([type and parse](packages/run-insights/src/triage.ts:111-119)).
2. Rejected paths are split with the host ownership callback. Code verdict identifies owned-path rejection or bookkeeping-only rejection as orchestrator-caused ([split](packages/run-insights/src/triage.ts:83-109)).
3. `triageState` builds task details and code facts for the judge; invalid contract JSON becomes an empty contract ([source](packages/run-insights/src/triage.ts:115-142)).
4. `triageQuestions` provides origin/category questions and adds same-rule only when rules are supplied ([source](packages/run-insights/src/triage.ts:32-75)).
5. Pending attempts are selected by reason/version hash; `saveTriage` stores a result. Summaries, writer groups, and origin helpers support reporting ([pending/save](packages/run-insights/src/triage.ts:144-174), [report functions](packages/run-insights/src/triage.ts:177-269)).

## Modes

| Field | Values | Meaning |
|---|---|---|
| Origin | `writer`, `orchestrator`, `environment`, `task`, `unclear` | Cause of failure ([vocabulary](packages/run-insights/src/triage.ts:28-48)) |
| Category | `missing_output`, `broke_checks`, `outside_scope`, `skipped_checks`, `acceptance_unmet`, `other` | Writer mistake category ([criteria](packages/run-insights/src/triage.ts:50-60)) |
| Stored status | `ok`, `error` | Whether classification was successfully recorded ([schema](packages/run-insights/src/triage.ts:8-25)) |

## Business rules

- Triage version is 2 and participates in the reason digest; bumping it makes old answers eligible again ([source](packages/run-insights/src/triage.ts:80-82), [hash](packages/run-insights/src/triage.ts:144-145)).
- Only an `ok` row counts as already triaged; same-rule question is omitted if no rules supplied ([query](packages/run-insights/src/triage.ts:147-159), [questions](packages/run-insights/src/triage.ts:62-74)).
- Host supplies path ownership matching ([split](packages/run-insights/src/triage.ts:88-99)).

## Public API or commands

Use `triageState`, `triageQuestions`, `splitRejectedPaths`, `codeVerdict`, `untriagedAttempts`, `saveTriage`, `writerGroups`, and report helpers; no package commands ([exports](packages/run-insights/src/index.ts:74-115)).

## Gotchas

Code verdict settles only the two ownership-gate cases; other reasons remain for judge classification. Without a supplied split, `triageState` puts parsed rejected paths into the outside list ([source](packages/run-insights/src/triage.ts:101-117)).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Run insights gotchas](../gotchas.md)
- [Run insights](../overview.md)
