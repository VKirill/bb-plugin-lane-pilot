---
title: Workflow UI Projections and Schedule Helpers
type: component
created: 2026-10-10
updated: 2026-10-27
status: active
confidence: high
tags: [workflow-engine, ui, schedules]
sources:
  - packages/workflow-engine/src/view.ts
  - packages/workflow-engine/src/draft-view.ts
  - packages/workflow-engine/src/view-core.ts
  - packages/workflow-engine/src/capabilities.ts
  - packages/workflow-engine/src/index.ts
  - packages/workflow-engine/src/edge-label.ts
  - packages/workflow-engine/src/cron.ts
  - packages/workflow-engine/src/ui.ts
  - src/rooms/schedule/time.ts
  - packages/workflow-engine/src/lower.ts
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
| `@lane-pilot/workflow-engine`: `modelsSection`, `collectCapabilities` | Build the model catalog projection and collect queried capability sections (`packages/workflow-engine/src/index.ts:4-5`, `packages/workflow-engine/src/capabilities.ts:38-67`, `packages/workflow-engine/src/capabilities.ts:141-187`). |

## Package shape

`view.ts` depends on lowering and produces complete graph projections; `draft-view.ts` and `edge-label.ts` avoid schema imports so browser consumers can render incomplete editing state and connection text (`packages/workflow-engine/src/view.ts:1-6`, `packages/workflow-engine/src/draft-view.ts:1-8`, `packages/workflow-engine/src/edge-label.ts:1-6`).

## Internal model

The complete view deliberately follows the lowered graph rather than the source graph, keeping displayed step IDs and edge indexes aligned with runtime. The draft view instead favors partial display over strict validation while a person edits a workflow (`packages/workflow-engine/src/view.ts:46-55`, `packages/workflow-engine/src/draft-view.ts:3-8`).

### `workflowView`

1. Lower the validated workflow with the optional resolver; the resulting graph is the graph used for display, including generated parallel node IDs (`packages/workflow-engine/src/view.ts:47-50`).
2. Convert each lowered node to a plain view node. Notes get a 400-character text excerpt; agents and humans get flattened/clipped prompt or question excerpts; lp-task, action, decision, parallel, join, and subworkflow nodes expose corresponding stages, action, source, loop, or called-workflow data (`packages/workflow-engine/src/view.ts:14-34`).
3. Add `$start` and `$end` display nodes only if an edge references those sentinels. Preserve edge indexes and pass modes, turn conditions into display text, and list carried field names (`packages/workflow-engine/src/view.ts:36-44`, `packages/workflow-engine/src/view.ts:48-55`).
4. Copy `ui.positions`, converting position keys `start` and `end` to `$start` and `$end`; include positions only when the resulting object has keys (`packages/workflow-engine/src/view.ts:53-55`).

The function assumes a parsed `Workflow` and catches neither lowering nor resolver errors; those exceptions propagate to the caller (`packages/workflow-engine/src/view.ts:47-55`, `packages/workflow-engine/src/lower.ts:17-19`).

### `draftView`

`draftView` projects unvalidated authoring JSON leniently. Non-record input becomes an empty object; non-array `nodes` and `edges` become empty collections (`packages/workflow-engine/src/draft-view.ts:9-14`, `packages/workflow-engine/src/draft-view.ts:62-71`).

| Draft input branch | Projection behavior |
|---|---|
| Node lacks a nonempty string `id` or is not a record | Omitted. A missing or unknown type with an ID is rendered as `agent`; known kinds get kind-specific tone and excerpts (`packages/workflow-engine/src/draft-view.ts:30-49`, `packages/workflow-engine/src/draft-view.ts:64-66`). |
| Outputs use `out` or legacy `output` | Array entries contribute a string value or record `name`; object maps contribute keys; other shapes produce no output names (`packages/workflow-engine/src/draft-view.ts:16-22`). |
| `entry` names an existing node and no edge starts at `start` | Adds a synthetic start edge before source edges. `start`/`end` are aliases for `$start`/`$end` only when no ordinary node has that ID (`packages/workflow-engine/src/draft-view.ts:67-72`). |
| Edge has a missing endpoint or a non-sentinel endpoint not in the projected node IDs | Omitted. For retained edges, unknown pass values default to `artifact`; condition text is projected only for strings or record-shaped conditions (`packages/workflow-engine/src/draft-view.ts:70-80`). |
| At least one retained edge uses a sentinel | Adds the corresponding terminal node. Position data keeps only entries with numeric `x` and `y`, aliases start/end keys, and is omitted when no valid entries remain (`packages/workflow-engine/src/draft-view.ts:52-59`, `packages/workflow-engine/src/draft-view.ts:82-85`). |

Malformed pieces are dropped or normalized rather than returned as validation diagnostics. Failures from the imported condition-text projection are not caught (`packages/workflow-engine/src/draft-view.ts:63-85`).

### `atom` in localized edge labels

`atom` handles one expression fragment at a time. It unwraps enclosing parentheses, recognizes negation, then tests membership, comparisons, and finally a bare field name; an unrecognized shape is returned as its trimmed original text (`packages/workflow-engine/src/edge-label.ts:62-74`, `packages/workflow-engine/src/edge-label.ts:100-150`).

| Recognized form | Output branch |
|---|---|
| `!field` | Uses special negative wording for known fields; other expressions recurse and receive a language-specific “not” wrapper (`packages/workflow-engine/src/edge-label.ts:103-109`). |
| `field in [...]` or `field not in [...]` | Translates values through status wording when appropriate; status fields omit the field name, ordinary fields include it, and unsupported left sides preserve original text (`packages/workflow-engine/src/edge-label.ts:110-119`). |
| `visits(id) <op> literal` | Zero equality uses a known node name or selected past-tense phrase when available; `<`/`<=` with a number becomes a run-count phrase; other comparisons remain unchanged (`packages/workflow-engine/src/edge-label.ts:120-136`). |
| `field.length` compared with zero | `> 0`/`!= 0` means nonempty; `== 0` means empty (`packages/workflow-engine/src/edge-label.ts:137-138`). |
| Field comparison or bare field | Status equality uses status wording; booleans use positive/negative field phrases; empty-string equality describes set/empty; other recognized comparisons translate field names and operators (`packages/workflow-engine/src/edge-label.ts:139-150`). |

`humanCondition` applies `atom` after splitting top-level `||` alternatives and `&&` conjunctions, then joins the localized phrases. When `bare` is false it prefixes “if”/“если”; an empty condition returns `null` (`packages/workflow-engine/src/edge-label.ts:46-60`, `packages/workflow-engine/src/edge-label.ts:153-161`).

### Model capability projection

`modelsSection` turns the supplied model catalog and settings into names a workflow author can use. It omits providers and models with no host IDs. A query matching a provider ID keeps that provider's models; otherwise its models are filtered by model ID or display name. The result includes at most 40 models per provider with a `moreModels` count, each model's supported node efforts, and host availability (`packages/workflow-engine/src/capabilities.ts:29-31`, `packages/workflow-engine/src/capabilities.ts:38-54`).

The result also lists connected-state host names, provider service tiers when supported, and each preset's resolved provider/model/reasoning choice and whether the run host offers that pair. It adds `notOnThisMachine` to model rows that are unavailable on the run host; the note describes preset and model fallback behavior (`packages/workflow-engine/src/capabilities.ts:38-67`). `collectCapabilities` returns models as unavailable when the port is absent, returns no catalog, or supplies no providers; a thrown model read becomes an error result (`packages/workflow-engine/src/capabilities.ts:169-175`). For the `specialists` section, it accepts either a supplied ID list or an async reader, returns the roles and usage note on success, and returns an error status if the reader throws (`packages/workflow-engine/src/capabilities.ts:24-26`, `packages/workflow-engine/src/capabilities.ts:177-184`).

### `collectCapabilities`

1. An omitted/empty section selection requests every section; otherwise only named sections are added. The optional query is trimmed and lowercased for substring matching by the simple list sections and by `modelsSection`; browser, specialist, and reference results are not query-filtered (`packages/workflow-engine/src/capabilities.ts:141-146`, `packages/workflow-engine/src/capabilities.ts:147-187`).
2. Skills, plugins, MCP servers, secrets, and hosts use the shared section reader: absent reader or null result is `unavailable`; successful results are filtered and capped at 120 items, with `total` when more matched; thrown reads become `{status: "error", items: [], error}` and collection continues (`packages/workflow-engine/src/capabilities.ts:30-31`, `packages/workflow-engine/src/capabilities.ts:70-80`, `packages/workflow-engine/src/capabilities.ts:147-154`). Skill descriptions are clipped to 160 characters. Secrets include names and kinds only, with the usage note (`packages/workflow-engine/src/capabilities.ts:147`, `packages/workflow-engine/src/capabilities.ts:150-152`).
3. Browser data reads plugins and skills independently; either rejected read becomes `null` for that sub-result. It also includes the configured browser host and static usage instructions (`packages/workflow-engine/src/capabilities.ts:155-167`).
4. Models are unavailable when no model port/catalog/providers exist, ready when the catalog can be projected, and error when the read throws (`packages/workflow-engine/src/capabilities.ts:169-175`). Specialists accept a list or async reader; success returns roles and a usage note, while a thrown reader returns error status (`packages/workflow-engine/src/capabilities.ts:177-184`). The reference section returns `WORKFLOW_REFERENCE` directly (`packages/workflow-engine/src/capabilities.ts:82-139`, `packages/workflow-engine/src/capabilities.ts:186`).

There is no outer catch around section construction. The shared reader catches errors for its five list sections; model and specialist reads have their own catches, and browser reads turn individual failures into nulls (`packages/workflow-engine/src/capabilities.ts:70-80`, `packages/workflow-engine/src/capabilities.ts:155-184`).

## Dependencies

The graph projections use workflow lowering and display types; the schedule helpers use built-in JavaScript `Intl` time-zone validation, and the `/ui` export contains no Node-only imports (`packages/workflow-engine/src/view.ts:1-3`, `packages/workflow-engine/src/cron.ts:26-31`, `packages/workflow-engine/src/ui.ts:1-4`). Model capability projection depends on the models catalog package and receives settings through its caller-provided catalog and settings arguments (`packages/workflow-engine/src/capabilities.ts:1-4`, `packages/workflow-engine/src/capabilities.ts:38-59`).

## Gotchas

- `cronProblem` validates syntax and numeric ranges but does not calculate upcoming firing times; the host schedule implementation owns that behavior (`packages/workflow-engine/src/cron.ts:8-23`, `src/rooms/schedule/time.ts:1-30`).
- A partial `draftView` omits unrecognized content, so its output is a display projection and not a validation report (`packages/workflow-engine/src/draft-view.ts:3-8`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](../overview.md)
