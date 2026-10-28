---
title: Workflow Execution Engine Internals
type: component
created: 2026-10-28
updated: 2026-10-28
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

This page records the branch behavior of `WorkflowEngine` preparation, `pureActionExecutor`, registered reducers, `createJournal`, and the SQL migration array. Run execution and public configuration are covered by [Workflow Execution Engine](execution-engine.md) (`packages/workflow-engine/src/engine.ts:153-221`, `packages/workflow-engine/src/actions.ts:176-198`, `packages/workflow-engine/src/reducers.ts:10-128`, `packages/workflow-engine/src/journal.ts:10-105`, `packages/workflow-engine/src/journal.ts:150-190`).

## How it works

1. `WorkflowEngine` chooses its clock, creates the journal, picks an instance ID and lease duration, and registers built-ins. `register` then adds or replaces executor-map entries; `hasExecutor` queries that map (`packages/workflow-engine/src/engine.ts:169-178`).
2. `compile` indexes executable nodes, groups outgoing edges, parses non-start edge conditions and `skip_when`, and maps joins by parallel ID. `compiled` caches the compiled form by run ID (`packages/workflow-engine/src/engine.ts:190-208`).
3. `preflight` combines workflow validation errors with missing executor-key/registration problems. It skips note nodes and returns the list without starting a run (`packages/workflow-engine/src/engine.ts:211-221`).
4. A pure action executor looks up the action, chooses its declared read references (or the fixed `verdict.aggregate` list), invokes code with the node/params/context, and returns the action output plus optional detail (`packages/workflow-engine/src/actions.ts:176-192`).
5. A reducer executor receives `results`, `failed`, `rows`, and `items`, defaulting missing values to empty arrays, then calls the reducer registered for that key (`packages/workflow-engine/src/reducers.ts:121-128`).
6. Journal methods read rows, append events, and conditionally change step/run state. `moveStep` enforces its transition table and expected source state before returning success (`packages/workflow-engine/src/journal.ts:150-189`).
7. The host applies `workflowMigrations` SQL strings in array order. The export itself does not open a database or execute the statements (`packages/workflow-engine/src/journal.ts:10-105`, `packages/workflow-engine/src/db.ts:1-4`).

## Modes and outcomes

| Operation | Branch | Result or failure |
|---|---|---|
| Preflight | Note node | Skipped by executor checks and omitted from the executable-node map (`packages/workflow-engine/src/engine.ts:190-201`, `packages/workflow-engine/src/engine.ts:214-220`). |
| Preflight | Runnable node has no executor key or key is unregistered | Adds a node problem and returns it with validation errors (`packages/workflow-engine/src/engine.ts:211-221`). |
| Compilation | Edge is from `$start` | No condition AST is compiled for that edge; other edges with `when` are converted with `toExpr` (`packages/workflow-engine/src/engine.ts:194-199`). |
| Pure action | `verdict.aggregate` | Uses the fixed `AGGREGATE_READS` list instead of `node.reads` (`packages/workflow-engine/src/actions.ts:180-182`). |
| Pure action | Other registered key | Uses `node.reads` or an empty list; out-of-range indexed reads return `undefined` (`packages/workflow-engine/src/actions.ts:188-190`). |
| Pure action | Unknown key or action throws | The map lookup has no fallback; action call failure propagates to the engine attempt path (`packages/workflow-engine/src/actions.ts:176-192`, `packages/workflow-engine/src/engine.ts:794-838`). |
| Reducer | Missing wrapper collection | `results`, `failed`, `rows`, or `items` defaults to `[]` (`packages/workflow-engine/src/reducers.ts:121-128`). |
| Reducer | Present malformed collection or thrown reducer error | No shape check or catch is applied; the executor rejects and the engine handles an attempt failure (`packages/workflow-engine/src/reducers.ts:121-128`, `packages/workflow-engine/src/engine.ts:794-838`). |
| Journal event | Event insert succeeds | Listener is called after insert; listener exceptions are swallowed (`packages/workflow-engine/src/journal.ts:155-160`). |
| Journal step transition | Allowed transition and expected current state | Updates the step, emits a `step` event, returns `true` (`packages/workflow-engine/src/journal.ts:162-179`). |
| Journal step transition | Illegal transition or stale/missing current state | Illegal transition throws; conditional update with no row emits `refused` and returns `false` (`packages/workflow-engine/src/journal.ts:162-179`). |
| Journal run status | Expected source status matches | Updates status and emits a `run` event; no matching row returns `false` without an event (`packages/workflow-engine/src/journal.ts:181-187`). |

## Business rules

- Compilation excludes `note` nodes, while preflight also skips them when checking executor registration (`packages/workflow-engine/src/engine.ts:190-201`, `packages/workflow-engine/src/engine.ts:214-220`).
- `pureActionExecutor` marks actions reentrant; its fixed map contains `items.dedupe`, `dag.validate`, `digest.check`, `citations.check`, `verdict.aggregate`, and `lp.propose_workflow` (`packages/workflow-engine/src/actions.ts:176-187`).
- Reducers are deterministic functions. `done` preserves branch order and supplies `{}` for missing data; `lost` selects non-ok rows. Per-key reducer outputs and their result-field conditions are listed in [Execution Engine reducer details](execution-engine.md#registerreducers) (`packages/workflow-engine/src/reducers.ts:19-28`, `packages/workflow-engine/src/reducers.ts:33-119`).
- Journal step writes are compare-and-set updates: callers supply allowed source states, and a competing writer cannot overwrite a state that no longer matches (`packages/workflow-engine/src/journal.ts:162-179`).
- The migration DDL constrains run statuses, step states, effect states, and keys; the event table has update/delete triggers that abort mutation (`packages/workflow-engine/src/journal.ts:11-104`).

## Public API

| Export | Purpose |
|---|---|
| `WorkflowEngine.register`, `hasExecutor`, `preflight` | Register executors, query registration, and collect validation/executor problems (`packages/workflow-engine/src/engine.ts:177-178`, `packages/workflow-engine/src/engine.ts:211-221`). |
| `pureActionExecutor`, `PURE_ACTION_KEYS`, `registerPureActions` | Create and register deterministic action executors (`packages/workflow-engine/src/actions.ts:183-198`). |
| `REDUCERS`, `registerReducers` | Map join reducer keys to functions and install them on an engine (`packages/workflow-engine/src/reducers.ts:33-128`). |
| `workflowMigrations`, `createJournal`, `STEP_TRANSITIONS` | Export SQL statements, journal methods, and allowed step transitions (`packages/workflow-engine/src/journal.ts:10-12`, `packages/workflow-engine/src/journal.ts:114-121`, `packages/workflow-engine/src/journal.ts:150-190`). |

## Gotchas

- `preflight` can return multiple problems; it does not mutate run state or start execution (`packages/workflow-engine/src/engine.ts:211-221`).
- A journal event notification callback is best-effort after the database insert; callback failure does not roll back the event (`packages/workflow-engine/src/journal.ts:155-160`).
- `workflowMigrations` is data only. The host owns database migration execution (`packages/workflow-engine/src/journal.ts:10-105`, `packages/workflow-engine/src/db.ts:1-4`).

## Related pages

- [Workflow Execution Engine](execution-engine.md)
- [Run journal data model](../data-model/run-journal.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Execution Engine](execution-engine.md)
