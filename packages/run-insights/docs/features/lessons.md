---
title: Lessons from runs
type: component
created: 2026-11-12
updated: 2026-11-12
status: active
confidence: medium
tags: [run-insights, lessons, memory]
sources:
  - packages/run-insights/src/lessons.ts
  - packages/run-insights/src/lesson-signatures.ts
  - packages/run-insights/src/rules.ts
  - packages/run-insights/src/index.ts
  - src/rooms/self-repair/server/insights.ts
  - packages/run-insights/src/rule-proposals.ts
---

# Lessons from runs

TL;DR: Run receipts and attempt failures can become memory notes and normalized groups of repeated writer mistakes.

## Purpose

`collectLessonSources` and `lessonCandidates` extract evidence and create memory candidate values. `repeatedLessons` and `draftRule` provide normalized repeat groups and initial wording ([exports](packages/run-insights/src/index.ts:9-10), [rules exports](packages/run-insights/src/rules.ts:5-9)). The host self-repair sweep consumes these functions ([caller](src/rooms/self-repair/server/insights.ts:1-7)).

## How it works

1. `collectLessonSources` clamps the row limit to 1–2000 (default 200), then reads selected receipts and failed/blocked/rejected/validation-failed attempts ([source](packages/run-insights/src/lessons.ts:29-39)).
2. Night-review JSON yields findings only with valid severity, path, and finding fields. Invalid JSON yields no findings ([source](packages/run-insights/src/lessons.ts:16-27)).
3. Failed/blocked lesson-stage receipts and qualifying attempts become sources unless their reasons match the noise filter. Results sort newest first ([filter](packages/run-insights/src/lessons.ts:12-14), [conversion](packages/run-insights/src/lessons.ts:40-50)).
4. `lessonCandidates` renders each kind into a `note`, derives concepts, and deduplicates identical content case-insensitively ([source](packages/run-insights/src/lessons.ts:53-88)).
5. `repeatedLessons` filters non-writer mistakes, normalizes their text, and counts once per run/task. Defaults require 3 occurrences and at least 2 task IDs ([normalization](packages/run-insights/src/lesson-signatures.ts:6-16), [grouping](packages/run-insights/src/lesson-signatures.ts:30-71)).

## Modes

| Kind | Input and result | Exclusions |
|---|---|---|
| `night_finding` | Valid warning/blocking finding becomes a note with path and optional suggested fix | Invalid JSON or required fields ([source](packages/run-insights/src/lessons.ts:16-27)) |
| `rejection` | Failed/blocked selected stage receipt becomes a source | Retry limit, exhausted attempts, cancel, thread deletion, plugin reload, `needs_human:` ([source](packages/run-insights/src/lessons.ts:12-14)) |
| `attempt_failure` | Failed, blocked, rejected, or validation-failed attempt with reason | Drill task IDs and noise reasons ([source](packages/run-insights/src/lessons.ts:36-49)) |

## Business rules

- Receipt stages are night-review, acceptance-receipt, verification, code-critique, and plan-critique; drill IDs beginning `drill-` are excluded ([source](packages/run-insights/src/lessons.ts:12-14), [queries](packages/run-insights/src/lessons.ts:32-39)).
- Repeated lessons omit plan-critique rejections, internal/run/PM failures, and ownership rejections involving bookkeeping-only paths ([source](packages/run-insights/src/lesson-signatures.ts:30-42)).
- One task counts once per signature for task count; repeated occurrences count distinct run/task pairs ([source](packages/run-insights/src/lesson-signatures.ts:51-69)).
- Lesson proposals use a same-rule similarity threshold of 0.6 and cap pending lesson proposals at 30; excess older proposals are rejected ([source](packages/run-insights/src/rule-proposals.ts:93-128)).

## Public API or commands

Exports: `collectLessonSources`, `lessonCandidates`, `repeatedLessons`, and `draftRule` ([package exports](packages/run-insights/src/index.ts:9-10), [rules exports](packages/run-insights/src/rules.ts:5-9)).

## Gotchas

SQL limits apply to rows before night-review findings expand, so returned source count can exceed the row limit. Candidate deduplication uses rendered content; repeated grouping uses normalized signatures ([source](packages/run-insights/src/lessons.ts:32-50), [dedupe](packages/run-insights/src/lessons.ts:66-87), [grouping](packages/run-insights/src/lesson-signatures.ts:48-71)).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Run insights gotchas](../gotchas.md)
- [Run insights](../overview.md)
