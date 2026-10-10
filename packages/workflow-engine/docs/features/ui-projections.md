---
title: Workflow UI Projections and Schedule Helpers
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [workflow-engine, ui, schedules]
sources:
  - packages/workflow-engine/src/view.ts
  - packages/workflow-engine/src/draft-view.ts
  - packages/workflow-engine/src/view-core.ts
  - packages/workflow-engine/src/edge-label.ts
  - packages/workflow-engine/src/cron.ts
  - packages/workflow-engine/src/ui.ts
  - src/rooms/schedule/time.ts
---
# Workflow UI Projections and Schedule Helpers
TL;DR: Browser-facing helpers turn validated workflows and incomplete drafts into graph display data, render readable edge conditions, and validate five-field schedules and IANA time zones.

## Purpose

`workflowView` produces plain display data from the lowered graph that runs; `draftView` tolerates incomplete draft JSON and omits pieces it cannot interpret. The `/ui` entry re-exports cron checks, draft views, edge-label helpers, and display types (`packages/workflow-engine/src/view.ts:8-12`, `packages/workflow-engine/src/draft-view.ts:3-8`, `packages/workflow-engine/src/ui.ts:1-4`).

## How it works

1. A complete workflow passes to `workflowView`, which lowers it, maps each node and edge to display fields, inserts explicit start/end sentinels when referenced, and retains canvas positions (`packages/workflow-engine/src/view.ts:14-55`).
2. An incomplete draft passes to `draftView`; it reads raw objects without closed-schema validation and drops nodes/edges that do not have enough interpretable shape (`packages/workflow-engine/src/draft-view.ts:3-8`, `packages/workflow-engine/src/draft-view.ts:30-54`, `packages/workflow-engine/src/draft-view.ts:63-87`).
3. `conditionText` converts structured boolean conditions into expression text. `humanCondition` converts recognized expression fragments to English or Russian prose; `edgeCaption` prefers the author label and otherwise uses that prose (`packages/workflow-engine/src/view-core.ts:30-39`, `packages/workflow-engine/src/edge-label.ts:153-168`).
4. Schedule consumers call `cronProblem` and `timezoneProblem`; they return `null` for accepted input or a problem string (`packages/workflow-engine/src/cron.ts:8-28`).

## Modes and failures

| Helper | Input mode | Result or failure |
|---|---|---|
| `workflowView` | Validated workflow, optional subworkflow resolver | Lowers the graph, so generated `:fan` and `:child` nodes and lowered edge indexes match runtime graph identities (`packages/workflow-engine/src/view.ts:46-55`). |
| `draftView` | Raw/incomplete draft object | Returns a partial view; unrecognized nodes or edges are skipped rather than raising schema errors (`packages/workflow-engine/src/draft-view.ts:3-8`, `packages/workflow-engine/src/draft-view.ts:30-54`). |
| `edgeCaption` | Explicit edge label and/or condition text | Nonempty explicit label wins; otherwise humanized condition; no condition gives `null` (`packages/workflow-engine/src/edge-label.ts:153-168`). |
| `cronProblem` | Five cron fields | Returns a message for wrong field count, unsupported syntax, zero step, or out-of-range/reversed values (`packages/workflow-engine/src/cron.ts:8-23`). |
| `timezoneProblem` | Time-zone name | Returns an error string when `Intl.DateTimeFormat` rejects the zone (`packages/workflow-engine/src/cron.ts:26-28`). |

## Business rules

- Cron input has exactly five fields in minute/hour/day-of-month/month/day-of-week order. Each field supports `*`, integer, range, comma-list, and positive step syntax; field bounds are minute 0–59, hour 0–23, day 1–31, month 1–12, weekday 0–7 (`packages/workflow-engine/src/cron.ts:6-23`).
- Cron names and Quartz `?`, `L`, and `W` forms are rejected by the parser’s accepted expression (`packages/workflow-engine/src/cron.ts:2-4`, `packages/workflow-engine/src/cron.ts:13-20`).
- A schedule without an explicit zone uses the machine’s resolved time zone, falling back to UTC (`packages/workflow-engine/src/cron.ts:30-31`).
- Display excerpts are clipped; prompts default to a 160-character excerpt and notes to 400 characters (`packages/workflow-engine/src/view.ts:12-12`, `packages/workflow-engine/src/view.ts:19-26`).

## Public API

| Import | Purpose |
|---|---|
| `@lane-pilot/workflow-engine`: `workflowView`, `conditionText`, `roleTone`, `WorkflowView`, `ViewNode`, `ViewEdge`, `NodeTone` | Complete-workflow graph projection and shared view types (`packages/workflow-engine/src/view.ts:5-6`, `packages/workflow-engine/src/view.ts:47-55`). |
| `@lane-pilot/workflow-engine/ui`: `cronProblem`, `timezoneProblem`, `localTimezone` | Schedule validation and default zone (`packages/workflow-engine/src/ui.ts:1`, `packages/workflow-engine/src/cron.ts:8-31`). |
| `@lane-pilot/workflow-engine/ui`: `draftView`, `draftChanges` | Partial draft display and diff (`packages/workflow-engine/src/ui.ts:2`, `packages/workflow-engine/src/draft-view.ts:63-102`). |
| `@lane-pilot/workflow-engine/ui`: `humanCondition`, `edgeCaption`, `OTHERWISE`, `LabelLang`, `NameOf` | Localized edge labels (`packages/workflow-engine/src/ui.ts:3`, `packages/workflow-engine/src/edge-label.ts:7-9`, `packages/workflow-engine/src/edge-label.ts:153-168`). |

## Package shape

`view.ts` depends on lowering and produces complete graph projections; `draft-view.ts` and `edge-label.ts` avoid schema imports so browser consumers can render incomplete editing state and connection text (`packages/workflow-engine/src/view.ts:1-6`, `packages/workflow-engine/src/draft-view.ts:1-8`, `packages/workflow-engine/src/edge-label.ts:1-6`).

## Internal model

The complete view deliberately follows the lowered graph rather than the source graph, keeping displayed step IDs and edge indexes aligned with runtime. The draft view instead favors partial display over strict validation while a person edits a workflow (`packages/workflow-engine/src/view.ts:46-55`, `packages/workflow-engine/src/draft-view.ts:3-8`).

## Dependencies

These helpers use workflow lowering, display types, and built-in JavaScript `Intl` time-zone validation; the `/ui` export contains no Node-only imports (`packages/workflow-engine/src/view.ts:1-3`, `packages/workflow-engine/src/cron.ts:26-31`, `packages/workflow-engine/src/ui.ts:1-4`).

## Gotchas

- `cronProblem` validates syntax and numeric ranges but does not calculate upcoming firing times; the host schedule implementation owns that behavior (`packages/workflow-engine/src/cron.ts:8-23`, `src/rooms/schedule/time.ts:1-30`).
- A partial `draftView` omits unrecognized content, so its output is a display projection and not a validation report (`packages/workflow-engine/src/draft-view.ts:3-8`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](../overview.md)
