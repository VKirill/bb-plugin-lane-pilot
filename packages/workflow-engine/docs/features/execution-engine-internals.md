---
title: Workflow Execution Engine Internals
type: component
created: 2026-10-28
updated: 2026-11-14
status: active
confidence: medium
tags: [workflow-engine, execution, journal, reducers]
sources:
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/compiled.ts
  - packages/workflow-engine/src/engine-builtins.ts
  - packages/workflow-engine/src/engine-step.ts
  - packages/workflow-engine/src/journal.ts
  - packages/workflow-engine/src/reducers.ts
  - packages/workflow-engine/src/actions.ts
  - packages/workflow-engine/src/validate.ts
  - packages/workflow-engine/src/values.ts
---
# Workflow Execution Engine Internals
TL;DR: Engine setup, code-only actions and reducers, and journal writes define the preparation and persistence behavior behind [Workflow Execution Engine](execution-engine.md).

## Purpose

This page records the branch behavior of `WorkflowEngine` preparation (`packages/workflow-engine/src/engine.ts:39-93`, `packages/workflow-engine/src/compiled.ts:14-26`, `packages/workflow-engine/src/engine-builtins.ts:20-91`), `pureActionExecutor` (`packages/workflow-engine/src/actions.ts:194-202`), registered reducers with `registerReducers` (`packages/workflow-engine/src/reducers.ts:152-160`), `createJournal` (`packages/workflow-engine/src/journal.ts:151-191`), and the `workflowMigrations` SQL array (`packages/workflow-engine/src/journal.ts:10-105`). Run execution and public configuration are covered by [Workflow Execution Engine](execution-engine.md).

## How it works

1. `WorkflowEngine` chooses its clock, creates the journal, picks an instance ID and lease duration, and registers built-ins (`packages/workflow-engine/src/engine.ts:40-63`, `packages/workflow-engine/src/engine-builtins.ts:20-91`). `register` then adds or replaces executor-map entries; `hasExecutor` queries that map (`packages/workflow-engine/src/engine.ts:65-66`).
2. `compile` indexes executable nodes, groups outgoing edges, parses non-start edge conditions and `skip_when`, and maps joins by parallel ID (`packages/workflow-engine/src/compiled.ts:14-26`). `compiled` caches the compiled form by run ID (`packages/workflow-engine/src/engine.ts:76-80`).
3. `preflight` combines workflow validation errors — under an optional resolver argument that defaults to the engine's — with missing executor-key/registration problems. It skips note nodes and returns the list without starting a run (`packages/workflow-engine/src/engine.ts:83-93`).
4. `pureActionExecutor` looks up the action, chooses its declared read references (or the fixed `verdict.aggregate` list), invokes code with the node/params/context, and returns the action output plus optional detail (`packages/workflow-engine/src/actions.ts:194-202`).
5. `registerReducers` installs executors that receive `results`, `failed`, `rows`, and `items`, defaulting missing values to empty arrays, then calls the reducer registered for that key (`packages/workflow-engine/src/reducers.ts:152-160`).
6. Journal methods read rows, append events, and conditionally change step/run state. `moveStep` enforces its transition table and expected source state before returning success (`packages/workflow-engine/src/journal.ts:151-188`).
7. The host applies `workflowMigrations` SQL strings in array order. The export itself does not open a database or execute the statements (`packages/workflow-engine/src/journal.ts:10-105`).

### `REDUCERS`

How `REDUCERS` works (`packages/workflow-engine/src/reducers.ts:33-150`):
1. **Input extraction**: `registerReducers` extracts branch `results`, `failed`, `rows`, and `items` from `ctx.input.with`, defaulting missing collections to empty arrays (`packages/workflow-engine/src/reducers.ts:11-18`, `packages/workflow-engine/src/reducers.ts:152-160`).
2. **Row partitioning**: helper `done(input)` collects completed branch rows preserving item and data; `lost(input)` collects failed rows where `ok` is false (`packages/workflow-engine/src/reducers.ts:19-28`, `packages/workflow-engine/src/reducers.ts:27-28`).
3. **Domain reduction**: the reducer registered under `reduce.<workflow>.<node>` evaluates branch rows and returns the join node's aggregated output record (`packages/workflow-engine/src/reducers.ts:33-150`). The map includes `reduce.issue-quick.review` and `reduce.debug.diagnose`; their output fields are listed in [Workflow Execution Runtime Internals](execution-runtime-internals.md#reducer-input-normalization-and-registration) (`packages/workflow-engine/src/reducers.ts:46-59`).

- **Conditions and modes**:
  - Status filter (`reduce.insights-post.posts`, `reduce.reels.render`, `reduce.reels.verify`, `reduce.seo-cocoon.evidence`): checks `data.status === "ok"`, `data.ok !== false`, or `data.skipped !== true` to separate success rows from failures (`packages/workflow-engine/src/reducers.ts:41-44`, `packages/workflow-engine/src/reducers.ts:105-112`, `packages/workflow-engine/src/reducers.ts:122-128`).
  - Three-way task split (`reduce.lp.build.run_tasks`): checks `row.ok` and `data.state` to partition tasks into `accepted_ids` (with merge commits), `blocked_ids` (`blocked` or `needs_human`), and `failed_ids` with verdict findings (`packages/workflow-engine/src/reducers.ts:75-87`).
  - Review pairing (`reduce.lp.review.dims`, `reduce.lp.review.confirm`): sorts findings by severity rank (`critical` to `info`), counts critical and high issues, and drops findings only when a branch succeeded with `confirmed === false` (`packages/workflow-engine/src/reducers.ts:88-94`, `packages/workflow-engine/src/reducers.ts:95-103`).
  - Aggregation (`reduce.web-research.search`, `reduce.x-to-telegram-digest.score`): deduplicates sources by URL and filters scores where `keep !== false`, collecting unique topics (`packages/workflow-engine/src/reducers.ts:131-135`, `packages/workflow-engine/src/reducers.ts:137-149`).

- **Outcomes and failures**: Each reducer returns a plain record that becomes the join step's `output` (`packages/workflow-engine/src/reducers.ts:153-159`). Missing input collections default to empty lists or records without throwing. A reducer error or malformed row structure that throws an unhandled exception rejects the executor call and enters the engine's `maxAttempts` retry path (`packages/workflow-engine/src/reducers.ts:152-160`, `packages/workflow-engine/src/engine-step.ts:192-247`). The per-key outputs are tabulated in [Workflow Execution Runtime Internals](execution-runtime-internals.md).

### `workflowMigrations`

`workflowMigrations` is an ordered array of SQL strings; it is data — the export opens no database and executes nothing, the host applies the statements in array order (`packages/workflow-engine/src/journal.ts:10-105`). The entries, in order (`packages/workflow-engine/src/journal.ts:10-105`):

1. `lane_pilot_wf_run`: run identity, snapshot, linkage, usage, and lease columns, with a CHECK restricting `status` to the seven-value vocabulary and counters defaulting to 0 (`packages/workflow-engine/src/journal.ts:11-39`).
2. Three run indexes: a partial unique index on `(parent_run_id,parent_step_key)` that applies to child runs only, plus indexes on `status` and the link columns (`packages/workflow-engine/src/journal.ts:40-42`).
3. `lane_pilot_wf_step`: composite primary key `(run_id,step_key)`, a CHECK restricting `state` to the eight step states, then a unique index on `(run_id,origin)` and an index on `state` (`packages/workflow-engine/src/journal.ts:43-69`).
4. `lane_pilot_wf_arrival` keyed by `(run_id,group_key,branch)` (`packages/workflow-engine/src/journal.ts:70-78`).
5. `lane_pilot_wf_effect` with a CHECK on its four-state `state` and `UNIQUE(run_id,step_key,effect_key)` (`packages/workflow-engine/src/journal.ts:79-91`).
6. `lane_pilot_wf_event` with an autoincrementing `seq`, a `(run_id,seq)` index, and two triggers that `RAISE(ABORT)` on any UPDATE or DELETE, which is what makes the timeline append-only (`packages/workflow-engine/src/journal.ts:92-104`).

Outcomes and failures: the statements are plain `CREATE TABLE`/`INDEX`/`TRIGGER` without `IF NOT EXISTS`, so the list is applied once per database and applying it again fails on the existing table (`packages/workflow-engine/src/journal.ts:10-105`). From then on the CHECKs and unique indexes reject invalid status/state values and duplicate keys at write time; a statement that fails midway leaves the earlier ones applied, and recovery is the host's decision.

## Modes and outcomes

| Operation | Branch | Result or failure |
|---|---|---|
| Preflight | Note node | Skipped by executor checks and omitted from the executable-node map (`packages/workflow-engine/src/compiled.ts:14-18`, `packages/workflow-engine/src/engine.ts:87`). |
| Preflight | Runnable node has no executor key or key is unregistered | Adds a node problem and returns it with validation errors (`packages/workflow-engine/src/engine.ts:83-93`). |
| Compilation | Edge is from `$start` | No condition AST is compiled for that edge; other edges with `when` are converted with `toExpr` (`packages/workflow-engine/src/compiled.ts:19-23`). |
| Pure action | `verdict.aggregate` | Uses the fixed `AGGREGATE_READS` list instead of `node.reads` (`packages/workflow-engine/src/actions.ts:190`, `packages/workflow-engine/src/actions.ts:198`). |
| Pure action | Other registered key | Uses `node.reads` or an empty list; out-of-range indexed reads return `undefined` (`packages/workflow-engine/src/actions.ts:198-200`). |
| Pure action | Unknown key or action throws | The map lookup has no fallback; action call failure propagates to the engine attempt path (`packages/workflow-engine/src/actions.ts:194-202`, `packages/workflow-engine/src/engine-step.ts:192-247`). |
| Reducer | Missing wrapper collection | `results`, `failed`, `rows`, or `items` defaults to `[]` (`packages/workflow-engine/src/reducers.ts:152-160`). |
| Reducer | Present malformed collection or thrown reducer error | No shape check or catch is applied; the executor rejects and the engine handles an attempt failure (`packages/workflow-engine/src/reducers.ts:152-160`, `packages/workflow-engine/src/engine-step.ts:192-247`). |
| Journal event | Event insert succeeds | Listener is called after insert; listener exceptions are swallowed (`packages/workflow-engine/src/journal.ts:156-161`). |
| Journal step transition | Allowed transition and expected current state | Updates the step, emits a `step` event, returns `true` (`packages/workflow-engine/src/journal.ts:163-180`). |
| Journal step transition | Illegal transition or stale/missing current state | Illegal transition throws; conditional update with no row emits `refused` and returns `false` (`packages/workflow-engine/src/journal.ts:163-180`). |
| Journal run status | Expected source status matches | Updates status and emits a `run` event; no matching row returns `false` without an event (`packages/workflow-engine/src/journal.ts:182-188`). |

## Business rules

- Compilation excludes `note` nodes, while preflight also skips them when checking executor registration (`packages/workflow-engine/src/compiled.ts:15-17`, `packages/workflow-engine/src/engine.ts:87`).
- `pureActionExecutor` marks actions reentrant; its fixed map contains `items.dedupe`, `dag.validate`, `digest.check`, `citations.check`, `verdict.aggregate`, `lp.path_class`, and `lp.propose_workflow` (`packages/workflow-engine/src/actions.ts:185-188`, `packages/workflow-engine/src/actions.ts:194-202`). `verdict.aggregate` reads the fixed `prepass.findings` reference in addition to dimension findings, dropped IDs, unchecked dimensions, and unmet criteria (`packages/workflow-engine/src/actions.ts:189-199`).
- Reducers are deterministic functions. `done` preserves branch order and supplies `{}` for missing data; `lost` selects non-ok rows. Per-key reducer outputs and their result-field conditions are listed in [Execution Engine reducer details](execution-engine.md#registerreducers) (`packages/workflow-engine/src/reducers.ts:19-28`, `packages/workflow-engine/src/reducers.ts:33-150`).
- Journal step writes are compare-and-set updates: callers supply allowed source states, and a competing writer cannot overwrite a state that no longer matches (`packages/workflow-engine/src/journal.ts:163-180`).
- The migration DDL in `workflowMigrations` defines composite primary and unique keys, checks status and state vocabularies, and sets append-only triggers on events (`packages/workflow-engine/src/journal.ts:10-105`).

## Public API

| Export | Purpose |
|---|---|
| `WorkflowEngine.register`, `hasExecutor`, `preflight` | Register executors, query registration, and collect validation/executor problems (`packages/workflow-engine/src/engine.ts:65-68`, `packages/workflow-engine/src/engine.ts:83-93`). |
| `pureActionExecutor`, `PURE_ACTION_KEYS`, `registerPureActions` | Create and register deterministic action executors (`packages/workflow-engine/src/actions.ts:192-207`). |
| `REDUCERS`, `registerReducers` | Map join reducer keys to functions and install them on an engine (`packages/workflow-engine/src/reducers.ts:33-136`). |
| `workflowMigrations`, `createJournal`, `STEP_TRANSITIONS` | Export SQL statements, journal methods, and allowed step transitions (`packages/workflow-engine/src/journal.ts:10-12`, `packages/workflow-engine/src/journal.ts:116-122`, `packages/workflow-engine/src/journal.ts:151-191`). |

## Gotchas

- `preflight` can return multiple problems; it does not mutate run state or start execution (`packages/workflow-engine/src/engine.ts:83-93`).
- A journal event notification callback is best-effort after the database insert; callback failure does not roll back the event (`packages/workflow-engine/src/journal.ts:156-161`).
- `workflowMigrations` is data only. The host owns database migration execution (`packages/workflow-engine/src/journal.ts:10-105`).

## Related pages

- [Workflow Execution Engine](execution-engine.md)
- [Run journal data model](../data-model/run-journal.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Execution Engine](execution-engine.md)
