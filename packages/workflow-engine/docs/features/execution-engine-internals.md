---
title: Workflow Execution Engine Internals
type: component
created: 2026-10-28
updated: 2026-10-30
status: active
confidence: high
tags: [workflow-engine, execution, journal, reducers]
sources:
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/journal.ts
  - packages/workflow-engine/src/reducers.ts
  - packages/workflow-engine/src/actions.ts
  - packages/workflow-engine/src/validate.ts
  - packages/workflow-engine/src/values.ts
  - packages/workflow-engine/src/db.ts
---
# Workflow Execution Engine Internals
TL;DR: Engine setup, code-only actions and reducers, and journal writes define the preparation and persistence behavior behind [Workflow Execution Engine](execution-engine.md).

## Purpose

This page records the branch behavior of `WorkflowEngine` preparation, `pureActionExecutor`, registered reducers, `createJournal`, and the SQL migration array. Run execution and public configuration are covered by [Workflow Execution Engine](execution-engine.md) (`packages/workflow-engine/src/engine.ts:182-253`, `packages/workflow-engine/src/actions.ts:176-198`, `packages/workflow-engine/src/reducers.ts:10-128`, `packages/workflow-engine/src/journal.ts:10-105`, `packages/workflow-engine/src/journal.ts:150-190`).

## How it works

1. `WorkflowEngine` chooses its clock, creates the journal, picks an instance ID and lease duration, and registers built-ins. `register` then adds or replaces executor-map entries; `hasExecutor` queries that map (`packages/workflow-engine/src/engine.ts:200-209`).
2. `compile` indexes executable nodes, groups outgoing edges, parses non-start edge conditions and `skip_when`, and maps joins by parallel ID. `compiled` caches the compiled form by run ID (`packages/workflow-engine/src/engine.ts:221-240`).
3. `preflight` combines workflow validation errors with missing executor-key/registration problems. It skips note nodes and returns the list without starting a run (`packages/workflow-engine/src/engine.ts:242-253`).
4. A pure action executor looks up the action, chooses its declared read references (or the fixed `verdict.aggregate` list), invokes code with the node/params/context, and returns the action output plus optional detail (`packages/workflow-engine/src/actions.ts:176-192`).
5. A reducer executor receives `results`, `failed`, `rows`, and `items`, defaulting missing values to empty arrays, then calls the reducer registered for that key (`packages/workflow-engine/src/reducers.ts:121-128`).
6. Journal methods read rows, append events, and conditionally change step/run state. `moveStep` enforces its transition table and expected source state before returning success (`packages/workflow-engine/src/journal.ts:150-189`).
7. The host applies `workflowMigrations` SQL strings in array order. The export itself does not open a database or execute the statements (`packages/workflow-engine/src/journal.ts:10-105`, `packages/workflow-engine/src/db.ts:1-4`).

### `REDUCERS`

`REDUCERS` maps a `reduce.<workflow>.<node>` key to a pure function from the join's input to the join's declared output fields; `registerReducers` installs each entry as a reentrant executor (`packages/workflow-engine/src/reducers.ts:33`, `packages/workflow-engine/src/reducers.ts:121-128`). Every reducer receives the same four collections, each defaulted to an empty array when the join wrapper passes none (`packages/workflow-engine/src/reducers.ts:11-16`, `packages/workflow-engine/src/reducers.ts:124-126`):

- `results`: the outputs of the branches that finished;
- `failed`: the branches a tolerant join let pass, with their `item`, `error`, and `blocked` flag;
- `rows`: every branch in branch order as `{ branch, item, ok, data?, error?, blocked? }`;
- `items`: the fan-out items the branches were started with.

Shared helpers do the common shaping: `rec`/`list`/`str` coerce malformed values to `{}`/`[]`/`""`, `idOf` derives a row's id from `item.id`, a string item, or `#<branch>`, `flat` and `unique` flatten and dedupe, `sev` counts one severity, and `done`/`lost` select the rows that finished or failed (`packages/workflow-engine/src/reducers.ts:19-28`).

The reducers branch only on row data, in a few recurring shapes:

| Branch shape | Condition on a row | Outcome |
|---|---|---|
| Status filter (`insights-post.posts`, `reels.render`, `reels.verify`, `seo-cocoon.evidence`) | `data.status === "ok"`, `data.ok === false`, or `data.skipped === true` | the row lands in the success list or in the failed/skipped list with its item or id (`packages/workflow-engine/src/reducers.ts:34-37`, `packages/workflow-engine/src/reducers.ts:74-81`, `packages/workflow-engine/src/reducers.ts:91-97`). |
| Three-way task split (`lp.build.run_tasks`) | a failed row's `blocked` flag; a succeeded row's `data.state` | accepted ids plus unique merge commits, blocked ids, failed ids, and the verdict findings of unaccepted work (`packages/workflow-engine/src/reducers.ts:44-56`). |
| Review pairing (`lp.review.dims`, `lp.review.confirm`) | severity rank, then original order; `confirmed === false` on a succeeded row | sorted findings with stable ids and critical/high counts; only that one condition drops a finding, everything else stays confirmed (`packages/workflow-engine/src/reducers.ts:57-73`, `packages/workflow-engine/src/reducers.ts:30-31`). |
| Aggregation (`web-research.search`, `x-to-telegram-digest.score`) | a source URL seen before; a score with `keep === false` | duplicates dropped, source-less subquestions reported unavailable; kept posts resolved from `score.item`, `score.post`, the batch index, or the raw score (`packages/workflow-engine/src/reducers.ts:99-104`, `packages/workflow-engine/src/reducers.ts:105-118`). |

Outcomes and failures: a reducer returns a plain record that becomes the join step's `output`; nothing validates its shape. A reducer that throws over malformed rows rejects the executor call and enters the engine's retry/failure path (`packages/workflow-engine/src/reducers.ts:44-56`, `packages/workflow-engine/src/reducers.ts:121-128`). The per-key outputs are tabulated in [Workflow Execution Runtime Internals](execution-runtime-internals.md).

### `workflowMigrations`

`workflowMigrations` is an ordered array of SQL strings; it is data — the export opens no database and executes nothing, the host applies the statements in array order (`packages/workflow-engine/src/journal.ts:10-105`, `packages/workflow-engine/src/db.ts:1-4`). The entries, in order (`packages/workflow-engine/src/journal.ts:11-104`):

1. `lane_pilot_wf_run`: run identity, snapshot, linkage, usage, and lease columns, with a CHECK restricting `status` to the seven-value vocabulary and counters defaulting to 0 (`packages/workflow-engine/src/journal.ts:11-39`).
2. Three run indexes: a partial unique index on `(parent_run_id,parent_step_key)` that applies to child runs only, plus indexes on `status` and the link columns (`packages/workflow-engine/src/journal.ts:40-42`).
3. `lane_pilot_wf_step`: composite primary key `(run_id,step_key)`, a CHECK restricting `state` to the eight step states, then a unique index on `(run_id,origin)` and an index on `state` (`packages/workflow-engine/src/journal.ts:43-69`).
4. `lane_pilot_wf_arrival` keyed by `(run_id,group_key,branch)` (`packages/workflow-engine/src/journal.ts:70-78`).
5. `lane_pilot_wf_effect` with a CHECK on its four-state `state` and `UNIQUE(run_id,step_key,effect_key)` (`packages/workflow-engine/src/journal.ts:79-91`).
6. `lane_pilot_wf_event` with an autoincrementing `seq`, a `(run_id,seq)` index, and two triggers that `RAISE(ABORT)` on any UPDATE or DELETE, which is what makes the timeline append-only (`packages/workflow-engine/src/journal.ts:92-104`).

Outcomes and failures: the statements are plain `CREATE TABLE`/`INDEX`/`TRIGGER` without `IF NOT EXISTS`, so the list is applied once per database and applying it again fails on the existing table (`packages/workflow-engine/src/journal.ts:11`, `packages/workflow-engine/src/journal.ts:43`). From then on the CHECKs and unique indexes reject invalid status/state values and duplicate keys at write time; a statement that fails midway leaves the earlier ones applied, and recovery is the host's decision.

## Modes and outcomes

| Operation | Branch | Result or failure |
|---|---|---|
| Preflight | Note node | Skipped by executor checks and omitted from the executable-node map (`packages/workflow-engine/src/engine.ts:221-222`, `packages/workflow-engine/src/engine.ts:246-247`). |
| Preflight | Runnable node has no executor key or key is unregistered | Adds a node problem and returns it with validation errors (`packages/workflow-engine/src/engine.ts:242-253`). |
| Compilation | Edge is from `$start` | No condition AST is compiled for that edge; other edges with `when` are converted with `toExpr` (`packages/workflow-engine/src/engine.ts:225-228`). |
| Pure action | `verdict.aggregate` | Uses the fixed `AGGREGATE_READS` list instead of `node.reads` (`packages/workflow-engine/src/actions.ts:180-182`). |
| Pure action | Other registered key | Uses `node.reads` or an empty list; out-of-range indexed reads return `undefined` (`packages/workflow-engine/src/actions.ts:188-190`). |
| Pure action | Unknown key or action throws | The map lookup has no fallback; action call failure propagates to the engine attempt path (`packages/workflow-engine/src/actions.ts:176-192`, `packages/workflow-engine/src/engine.ts:854-899`). |
| Reducer | Missing wrapper collection | `results`, `failed`, `rows`, or `items` defaults to `[]` (`packages/workflow-engine/src/reducers.ts:121-128`). |
| Reducer | Present malformed collection or thrown reducer error | No shape check or catch is applied; the executor rejects and the engine handles an attempt failure (`packages/workflow-engine/src/reducers.ts:121-128`, `packages/workflow-engine/src/engine.ts:854-899`). |
| Journal event | Event insert succeeds | Listener is called after insert; listener exceptions are swallowed (`packages/workflow-engine/src/journal.ts:155-160`). |
| Journal step transition | Allowed transition and expected current state | Updates the step, emits a `step` event, returns `true` (`packages/workflow-engine/src/journal.ts:162-179`). |
| Journal step transition | Illegal transition or stale/missing current state | Illegal transition throws; conditional update with no row emits `refused` and returns `false` (`packages/workflow-engine/src/journal.ts:162-179`). |
| Journal run status | Expected source status matches | Updates status and emits a `run` event; no matching row returns `false` without an event (`packages/workflow-engine/src/journal.ts:181-187`). |

## Business rules

- Compilation excludes `note` nodes, while preflight also skips them when checking executor registration (`packages/workflow-engine/src/engine.ts:221-222`, `packages/workflow-engine/src/engine.ts:246-247`).
- `pureActionExecutor` marks actions reentrant; its fixed map contains `items.dedupe`, `dag.validate`, `digest.check`, `citations.check`, `verdict.aggregate`, and `lp.propose_workflow` (`packages/workflow-engine/src/actions.ts:176-187`).
- Reducers are deterministic functions. `done` preserves branch order and supplies `{}` for missing data; `lost` selects non-ok rows. Per-key reducer outputs and their result-field conditions are listed in [Execution Engine reducer details](execution-engine.md#registerreducers) (`packages/workflow-engine/src/reducers.ts:19-28`, `packages/workflow-engine/src/reducers.ts:33-119`).
- Journal step writes are compare-and-set updates: callers supply allowed source states, and a competing writer cannot overwrite a state that no longer matches (`packages/workflow-engine/src/journal.ts:162-179`).
- The migration DDL constrains run statuses, step states, effect states, and keys; the event table has update/delete triggers that abort mutation (`packages/workflow-engine/src/journal.ts:11-104`).

## Public API

| Export | Purpose |
|---|---|
| `WorkflowEngine.register`, `hasExecutor`, `preflight` | Register executors, query registration, and collect validation/executor problems (`packages/workflow-engine/src/engine.ts:208-209`, `packages/workflow-engine/src/engine.ts:242-253`). |
| `pureActionExecutor`, `PURE_ACTION_KEYS`, `registerPureActions` | Create and register deterministic action executors (`packages/workflow-engine/src/actions.ts:183-198`). |
| `REDUCERS`, `registerReducers` | Map join reducer keys to functions and install them on an engine (`packages/workflow-engine/src/reducers.ts:33-128`). |
| `workflowMigrations`, `createJournal`, `STEP_TRANSITIONS` | Export SQL statements, journal methods, and allowed step transitions (`packages/workflow-engine/src/journal.ts:10-12`, `packages/workflow-engine/src/journal.ts:114-121`, `packages/workflow-engine/src/journal.ts:150-190`). |

## Gotchas

- `preflight` can return multiple problems; it does not mutate run state or start execution (`packages/workflow-engine/src/engine.ts:242-253`).
- A journal event notification callback is best-effort after the database insert; callback failure does not roll back the event (`packages/workflow-engine/src/journal.ts:155-160`).
- `workflowMigrations` is data only. The host owns database migration execution (`packages/workflow-engine/src/journal.ts:10-105`, `packages/workflow-engine/src/db.ts:1-4`).

## Related pages

- [Workflow Execution Engine](execution-engine.md)
- [Run journal data model](../data-model/run-journal.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Execution Engine](execution-engine.md)
