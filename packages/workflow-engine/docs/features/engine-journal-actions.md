---
title: Engine, Journal, and Pure Action Details
type: component
created: 2026-10-24
updated: 2026-11-08
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

1. Construction keeps the supplied options, selects `options.now` or `Date.now`, creates a journal using the database and event hook, selects the supplied instance ID or a generated `engine-<uuid prefix>`, sets the lease to the supplied value or 90 seconds, then registers built-ins (`packages/workflow-engine/src/engine.ts:210-216`). The compatibility stamp `compat` resolves `compatVersion` when present and otherwise `harnessVersion` (`packages/workflow-engine/src/engine.ts:207`).
2. `register(key, executor)` writes to `executors`, replacing any executor already under that key; `hasExecutor` reports whether a key is present, and `resolveWorkflow` resolves subworkflows through the engine (`packages/workflow-engine/src/engine.ts:218-221`).
3. `compile` removes note nodes, groups outgoing edges with their source-array indexes, parses conditions on non-start edges and each `skip_when`, and maps each join by its parallel node. `compiled` parses the lowered definition saved in the run row and caches the compiled result by run ID (`packages/workflow-engine/src/engine.ts:233-252`).
4. `preflight` first collects only `error` diagnostics from `validateWorkflow`, lowers the workflow, skips notes, and checks every remaining node for an executor key and registered implementation. Missing keys and registrations are appended to the same problem list; the method returns that list without creating a run (`packages/workflow-engine/src/engine.ts:255-265`).
5. `createJournal` closes over the database and clock and exposes run/step reads, event insertion, conditional step movement, and conditional run status changes (`packages/workflow-engine/src/journal.ts:151-191`).
6. The `pureActionExecutor` wrapper selects its declared reference list, resolves requested refs through `ctx.resolve`, invokes the fixed action implementation with node, defaulted params, reader, and context, then returns output and optional detail (`packages/workflow-engine/src/actions.ts:194-202`).

### `WorkflowEngine`

How `WorkflowEngine` works (`packages/workflow-engine/src/engine.ts:192-251`):
1. **Construction**: `constructor` takes `EngineOptions` (`db`, `harnessVersion`, optional `compatVersion`, `leaseMs` defaulting to 90s, `instanceId`, `now`, `onEvent`), creates a `Journal` with `createJournal(options.db, this.now, options.onEvent)`, and registers built-in executors via `registerBuiltins()` (`packages/workflow-engine/src/engine.ts:210-216`).
2. **Registration**: `register(key, executor)` stores the executor in `executors` and returns `this` for chaining; `hasExecutor(key)` checks whether a key is present, and `resolveWorkflow(id, version)` delegates to the configured subworkflow resolver (`packages/workflow-engine/src/engine.ts:218-221`).
3. **Attempt tracking**: `spawnKeyOf(runId, step, attempt)` hashes `runId|step_key|attempt|rerun` to a 32-character SHA-256 hex key for reproducible agent threads (`packages/workflow-engine/src/engine.ts:224-227`).
4. **Compilation**: `compile(wf)` filters out `note` nodes, groups outgoing edges by source index, parses edge `when` conditions and node `skip_when` into ASTs via `toExpr`, and indexes join nodes by parallel ID (`packages/workflow-engine/src/engine.ts:233-245`). `compiled(run)` deserializes `definition_json` and caches the `Compiled` instance in `compiledRuns` (`packages/workflow-engine/src/engine.ts:248-252`).
- **Conditions and modes**: The compatibility stamp `compat` resolves `options.compatVersion ?? options.harnessVersion` (`packages/workflow-engine/src/engine.ts:207`); `stopped()` checks `disposed` or `options.isDisposed()` (`packages/workflow-engine/src/engine.ts:228`).
- **Outcomes and failures**: Construction creates a ready engine. Parsing invalid JSON or malformed expressions in stored definitions throws syntax errors on first compilation (`packages/workflow-engine/src/engine.ts:248-252`).

### `WorkflowEngine` state

The engine keeps its coordination state in per-run maps and sets, so runs do not interfere (`packages/workflow-engine/src/engine.ts:192-209`):

| Field | Holds | Read/written by |
|---|---|---|
| `executors` | Node executors by registered key. | `register` overwrites an existing key; `hasExecutor` queries it and `preflight` checks it (`packages/workflow-engine/src/engine.ts:195`, `packages/workflow-engine/src/engine.ts:218-219`). |
| `drives` | The in-flight drive promise of each run. | `drive` returns the existing promise instead of starting a second loop, and drops the entry when the loop ends (`packages/workflow-engine/src/engine.ts:196`, `packages/workflow-engine/src/engine.ts:330-335`). |
| `runtimes` | The caller's runtime per run, set at start or built once through `runtimeFor` on first need (`packages/workflow-engine/src/engine.ts:197`, `packages/workflow-engine/src/engine.ts:756-760`). | |
| `aborts` | The `AbortController` of each active run. | `failRun` and `cancel` abort it to stop sibling branches and waiting steps (`packages/workflow-engine/src/engine.ts:198`, `packages/workflow-engine/src/engine.ts:641-646`, `packages/workflow-engine/src/engine.ts:1506-1510`). |
| `compiledRuns`, `retired` | Compiled graph per run; finished runs are kept until `RETAINED_RUNS` (64) newer runs have finished, then their graph and runtime are dropped (`packages/workflow-engine/src/engine.ts:200-202`, `packages/workflow-engine/src/engine.ts:38`, `packages/workflow-engine/src/engine.ts:351-362`). | |
| `beats` | One lease-renewal timer per claimed run, firing every `leaseMs/3` (`packages/workflow-engine/src/engine.ts:203`, `packages/workflow-engine/src/engine.ts:368-375`). | |
| `stoppedRuns` | Runs whose driver stopped at a step boundary (drain or dispose); they report `stopped: true` (`packages/workflow-engine/src/engine.ts:204`, `packages/workflow-engine/src/engine.ts:410`). | |

Small helpers: `compat` is the stamp compared on reload (`packages/workflow-engine/src/engine.ts:207`), `stopped` combines the disposed flag with the host's `isDisposed` (`packages/workflow-engine/src/engine.ts:228`), and `fault`/`log` are the test and diagnostics hooks (`packages/workflow-engine/src/engine.ts:222-229`). Outcomes and failures of this setup: `compile` of a stored definition parses JSON and expressions with no local catch, so invalid persisted content throws on first use (`packages/workflow-engine/src/engine.ts:233-245`); `retire` skips a run that is being driven again and keeps the compiled graph of the newest 64 finished runs for cheap re-runs (`packages/workflow-engine/src/engine.ts:351-362`).

### `STEP_TRANSITIONS`

`STEP_TRANSITIONS` is the allow-list the journal checks a step move against: one entry per source state listing its legal targets, and the four terminal states (`succeeded`, `failed`, `skipped`, `canceled`) share an empty list, so no move out of them exists (`packages/workflow-engine/src/journal.ts:116-122`). One transition is deliberately against the flow of work: `running -> pending` is the resume of a reentrant step after a reload (`packages/workflow-engine/src/journal.ts:115-118`).

`moveStep` validates transitions against `STEP_TRANSITIONS` before issuing conditional updates (`packages/workflow-engine/src/journal.ts:163-180`):

1. Every supplied source state is checked against the table first; a target the table does not list for that source throws `illegal workflow step transition <from> -> <to>` before any SQL runs (`packages/workflow-engine/src/journal.ts:166-168`).
2. The UPDATE is then conditional on the row still being in one of the source states, so a competing writer cannot move a step that has moved on (`packages/workflow-engine/src/journal.ts:175-176`).
3. Outcomes: no changed row appends a `refused` event and returns `false`; a changed row appends a `step` event carrying the patch's `error` when present and returns `true` (`packages/workflow-engine/src/journal.ts:177-179`). Run status changes use a plain expected-status guard instead of the table, with the same false-without-event outcome on no match (`packages/workflow-engine/src/journal.ts:182-188`).

## Modes and outcomes

| Operation | Branch or condition | Outcome or failure |
|---|---|---|
| Engine configuration | Injected `now`, `instanceId`, and `leaseMs` values are used when present; defaults are wall clock, generated `engine-<uuid prefix>`, and 90 seconds (`packages/workflow-engine/src/engine.ts:210-216`). | Constructor creates the journal and registers built-ins. |
| Executor registration | Registering an existing key overwrites its map entry (`packages/workflow-engine/src/engine.ts:218-221`). | Future lookup uses the latest executor for that key. |
| Preflight | Validation errors and executor-resolution/registration problems are accumulated (`packages/workflow-engine/src/engine.ts:255-265`). | Returns `string[]`; it does not start or persist a run. |
| Preflight call throws | A validation or lowering call throws, including a throwing resolver | `preflight` has no catch around those calls, so the exception propagates rather than becoming a problem string (`packages/workflow-engine/src/engine.ts:255-265`). |
| Graph compilation | Notes are filtered; non-start edge conditions and `skip_when` expressions are parsed; joins are indexed (`packages/workflow-engine/src/engine.ts:233-245`). | Compiled graph is cached per run. Invalid stored JSON or expression syntax throws at compilation; this method does not catch it (`packages/workflow-engine/src/engine.ts:248-252`). |
| Event callback | Event row is inserted first; callback exceptions are caught (`packages/workflow-engine/src/journal.ts:156-161`). | Notification failure does not fail the event call; database insert/serialization errors propagate. |
| `moveStep` transition | Requested target must appear in `STEP_TRANSITIONS` for every supplied source state (`packages/workflow-engine/src/journal.ts:163-168`). | Illegal move throws. Conditional update with no matching row emits `refused` and returns false; success emits `step` and returns true (`packages/workflow-engine/src/journal.ts:175-179`). |
| `setRunStatus` transition | Update applies only when current status is in the supplied `from` set (`packages/workflow-engine/src/journal.ts:182-185`). | No changed row returns false without an event; success records a `run` event and returns true. |
| Pure action key | The map contains `items.dedupe`, `dag.validate`, `digest.check`, `citations.check`, `verdict.aggregate`, and `lp.propose_workflow`; `verdict.aggregate` uses its fixed reference list, all others use `node.reads` or an empty list (`packages/workflow-engine/src/actions.ts:185-188`, `packages/workflow-engine/src/actions.ts:190`, `packages/workflow-engine/src/actions.ts:197-199`). | Known key returns an output and optional detail; an unknown key has no guard and fails when `run` dereferences the absent action (`packages/workflow-engine/src/actions.ts:194-202`). |
| Pure action error | `pureActionExecutor` does not wrap execution in a local catch (`packages/workflow-engine/src/actions.ts:194-202`). | Ordinary errors reach the engine attempt loop, which records and retries them through `maxAttempts` before failing the step/run; engine bugs checked by `isEngineBug` are rethrown without step-failure handling (`packages/workflow-engine/src/engine.ts:166`, `packages/workflow-engine/src/engine.ts:923-950`). |

## Business rules

- A step transition is checked against `STEP_TRANSITIONS` before the database update; the update is conditional on the row still having an expected source state (`packages/workflow-engine/src/journal.ts:116-122`, `packages/workflow-engine/src/journal.ts:163-176`).
- A stale step move is observable as a `refused` event; a stale run status change returns false without adding an event (`packages/workflow-engine/src/journal.ts:177-188`).
- Only aggregate critique reads override node-declared reads via `AGGREGATE_READS` (`packages/workflow-engine/src/actions.ts:190`, `packages/workflow-engine/src/actions.ts:198-200`).
- Pure actions are marked reentrant, so the engine may rerun them after an interruption under its reentrant recovery path (`packages/workflow-engine/src/actions.ts:196`, `packages/workflow-engine/src/engine.ts:98-104`).

## Public API

| Export | Purpose |
|---|---|
| `WorkflowEngine` | Configure executor registration, preflight, and run coordination (`packages/workflow-engine/src/engine.ts:192-265`). |
| `createJournal` | Create the journal's query and conditional write methods (`packages/workflow-engine/src/journal.ts:151-191`). |
| `pureActionExecutor(key)` | Adapt a registered code-only action to `NodeExecutor` (`packages/workflow-engine/src/actions.ts:194-202`). |
| `PURE_ACTION_KEYS`, `registerPureActions` | List and register the fixed action implementations (`packages/workflow-engine/src/actions.ts:192-207`). |

## Gotchas

- `preflight` validates and checks executor availability, but returns diagnostics instead of starting work (`packages/workflow-engine/src/engine.ts:255-265`).
- `compile` trusts the stored definition JSON and parses expressions without a local catch; invalid persisted content can throw when first compiled (`packages/workflow-engine/src/engine.ts:233-252`).
- Journal update errors are not converted into `false`; the false result is specifically the conditional update changing no rows. Database failures propagate (`packages/workflow-engine/src/journal.ts:175-188`).
- A pure action key is not checked when `pureActionExecutor` is created. A caller that supplies an unknown key gets a returned wrapper that fails only when run (`packages/workflow-engine/src/actions.ts:194-202`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Run Journal Data](../data-model/run-journal.md)
- [Workflow Execution Engine](execution-engine.md)
