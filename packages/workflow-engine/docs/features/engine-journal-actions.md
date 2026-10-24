---
title: Engine, Journal, and Pure Action Details
type: component
created: 2026-10-24
updated: 2026-10-24
status: active
confidence: high
tags: [workflow-engine, execution, journal, actions]
sources:
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/journal.ts
  - packages/workflow-engine/src/actions.ts
---
# Engine, Journal, and Pure Action Details
TL;DR: The engine prepares a compiled graph and executor registry; the journal applies conditional state changes; pure actions adapt deterministic functions to the executor interface.

## Purpose

This page describes engine setup and preflight, the journal factory returned to the driver, and the wrapper that runs code-only actions. The main execution flow and durable schema are covered by [Workflow Execution Engine](execution-engine.md) and the [run journal data model](../data-model/run-journal.md).

## How it works

1. `WorkflowEngine` stores its options, selects the injected clock or `Date.now`, creates a journal with the database and event callback, chooses the supplied or generated instance ID, selects a lease duration, and registers built-in executors (`packages/workflow-engine/src/engine.ts:168-174`).
2. `register(key, executor)` replaces the current implementation for that key and returns the engine for chaining; `hasExecutor` tests registry membership (`packages/workflow-engine/src/engine.ts:176-177`).
3. `preflight` collects validation errors, lowers the workflow, ignores note nodes, then checks each runnable node for a resolvable executor key and registration. It returns problem messages and does not create a run (`packages/workflow-engine/src/engine.ts:210-220`).
4. When a run first needs a compiled graph, `compiled` parses the journal's stored definition and calls `compile`; the result is cached by run ID. `compile` excludes notes, groups outgoing edges, parses conditions on non-entry edges and `skip_when` values, and indexes joins by their parallel node (`packages/workflow-engine/src/engine.ts:189-207`).
5. `createJournal` closes over the database and clock and exposes run/step reads, event insertion, conditional step movement, and conditional run status changes (`packages/workflow-engine/src/journal.ts:150-153`, `packages/workflow-engine/src/journal.ts:189-190`).
6. The pure-action wrapper selects its declared reference list, resolves requested refs through `ctx.resolve`, invokes the fixed action implementation with node, defaulted params, reader, and context, then returns output and optional detail (`packages/workflow-engine/src/actions.ts:176-193`).

## Modes and outcomes

| Operation | Branch or condition | Outcome or failure |
|---|---|---|
| Engine configuration | Injected `now`, `instanceId`, and `leaseMs` values are used when present; defaults are wall clock, generated `engine-<uuid prefix>`, and 90 seconds (`packages/workflow-engine/src/engine.ts:168-173`). | Constructor creates the journal and registers built-ins. |
| Executor registration | Registering an existing key overwrites its map entry (`packages/workflow-engine/src/engine.ts:176-177`). | Future lookup uses the latest executor for that key. |
| Preflight | Validation errors and executor-resolution/registration problems are accumulated (`packages/workflow-engine/src/engine.ts:210-220`). | Returns `string[]`; it does not start or persist a run. |
| Graph compilation | Notes are filtered; non-start edge conditions and `skip_when` expressions are parsed; joins are indexed (`packages/workflow-engine/src/engine.ts:189-200`). | Compiled graph is cached per run. Invalid stored JSON or expression syntax throws at compilation; this method does not catch it (`packages/workflow-engine/src/engine.ts:203-207`). |
| Event callback | Event row is inserted first; callback exceptions are caught (`packages/workflow-engine/src/journal.ts:155-160`). | Notification failure does not fail the event call; database insert/serialization errors propagate. |
| `moveStep` transition | Requested target must appear in `STEP_TRANSITIONS` for every supplied source state (`packages/workflow-engine/src/journal.ts:162-166`). | Illegal move throws. Conditional update with no matching row emits `refused` and returns false; success emits `step` and returns true (`packages/workflow-engine/src/journal.ts:174-178`). |
| `setRunStatus` transition | Update applies only when current status is in the supplied `from` set (`packages/workflow-engine/src/journal.ts:181-183`). | No changed row returns false without an event; success records a `run` event and returns true. |
| Pure action key | The map contains `items.dedupe`, `dag.validate`, `digest.check`, `citations.check`, `verdict.aggregate`, and `lp.propose_workflow`; `verdict.aggregate` uses its fixed reference list, all others use `node.reads` or an empty list (`packages/workflow-engine/src/actions.ts:176-181`, `packages/workflow-engine/src/actions.ts:188-190`). | Known key returns an output and optional detail; an unknown key has no guard and fails when `run` dereferences the absent action (`packages/workflow-engine/src/actions.ts:185-192`). |
| Pure action error | Action execution is not wrapped in a local catch (`packages/workflow-engine/src/actions.ts:187-192`). | Ordinary errors reach the engine attempt loop, which records and retries them through `maxAttempts` before failing the step/run; engine bugs are rethrown without step-failure handling (`packages/workflow-engine/src/engine.ts:812-827`, `packages/workflow-engine/src/engine.ts:120-125`). |

## Business rules

- A step transition is checked against `STEP_TRANSITIONS` before the database update; the update is conditional on the row still having an expected source state (`packages/workflow-engine/src/journal.ts:114-121`, `packages/workflow-engine/src/journal.ts:162-175`).
- A stale step move is observable as a `refused` event; a stale run status change returns false without adding an event (`packages/workflow-engine/src/journal.ts:174-186`).
- Only `verdict.aggregate` overrides node-declared reads. Other pure actions resolve the indexed references from `node.reads` in order (`packages/workflow-engine/src/actions.ts:180-190`).
- Pure actions are marked reentrant, so the engine may rerun them after an interruption under its reentrant recovery path (`packages/workflow-engine/src/actions.ts:185-188`, `packages/workflow-engine/src/engine.ts:68-74`).

## Public API

| Export | Purpose |
|---|---|
| `WorkflowEngine` | Configure executor registration, preflight, and run coordination (`packages/workflow-engine/src/engine.ts:151-177`, `packages/workflow-engine/src/engine.ts:210-220`). |
| `createJournal` | Create the journal's query and conditional write methods (`packages/workflow-engine/src/journal.ts:150-190`). |
| `pureActionExecutor(key)` | Adapt a registered code-only action to `NodeExecutor` (`packages/workflow-engine/src/actions.ts:185-193`). |
| `PURE_ACTION_KEYS`, `registerPureActions` | List and register the fixed action implementations (`packages/workflow-engine/src/actions.ts:176-197`). |

## Gotchas

- `preflight` validates and checks executor availability, but returns diagnostics instead of starting work (`packages/workflow-engine/src/engine.ts:210-220`).
- `compile` trusts the stored definition JSON and parses expressions without a local catch; invalid persisted content can throw when first compiled (`packages/workflow-engine/src/engine.ts:189-207`).
- Journal update errors are not converted into `false`; the false result is specifically the conditional update changing no rows. Database failures propagate (`packages/workflow-engine/src/journal.ts:174-187`).
- A pure action key is not checked when `pureActionExecutor` is created. A caller that supplies an unknown key gets a returned wrapper that fails only when run (`packages/workflow-engine/src/actions.ts:185-192`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Execution Engine](execution-engine.md)
