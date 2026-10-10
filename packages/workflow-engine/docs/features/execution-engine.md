---
title: Workflow Execution Engine
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [workflow-engine, execution, journal]
sources:
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/db.ts
  - packages/workflow-engine/src/journal.ts
  - packages/workflow-engine/src/lower.ts
  - packages/workflow-engine/src/schema.ts
  - packages/workflow-engine/src/actions.ts
  - packages/workflow-engine/src/reducers.ts
---
# Workflow Execution Engine
TL;DR: `WorkflowEngine` drives lowered workflow graphs by claiming journaled steps, calling registered executors, validating outputs, and recording completion, waits, or failures.

## Purpose

The engine runs a workflow against caller-provided node executors and persists run, step, join, and effect state in SQLite so the host can resume or inspect work after a process restart (`packages/workflow-engine/src/engine.ts:151-177`, `packages/workflow-engine/src/journal.ts:10-105`).

## How it works

1. The caller constructs `WorkflowEngine` with a database and `harnessVersion`; construction creates the journal and registers built-in executors (`packages/workflow-engine/src/engine.ts:94-118`, `packages/workflow-engine/src/engine.ts:168-174`).
2. The host registers custom executors by key. An executor implements `run`, may declare itself reentrant, and may implement `poll` for waiting steps (`packages/workflow-engine/src/engine.ts:68-74`, `packages/workflow-engine/src/engine.ts:176-177`).
3. At start, workflow nodes are lowered into executable nodes and `for_each`/parallel forms; the run stores its workflow identity, version, hash, definition, mode, inputs, and usage counters (`packages/workflow-engine/src/lower.ts:52-101`, `packages/workflow-engine/src/engine.ts:151-177`, `packages/workflow-engine/src/journal.ts:11-39`).
4. The driver claims pending steps, resolves mapped inputs and references, then calls the selected executor with a `StepContext` containing run/step identity, attempt, goals, input, mode, and effect support (`packages/workflow-engine/src/engine.ts:18-66`).
5. A done result passes declared output fields and node contracts; a wait result persists partial output and wait details; thrown step errors move the step and run to failure unless classified as an engine/process bug (`packages/workflow-engine/src/engine.ts:35-38`, `packages/workflow-engine/src/engine.ts:124-145`).
6. Completed branches route through graph edges and joins; event rows accompany transitions. External side effects use `ctx.effect` to record intent and outcome for restart reconciliation (`packages/workflow-engine/src/journal.ts:155-187`, `packages/workflow-engine/src/engine.ts:64-65`).

## Modes and states

| Branch | Inputs or condition | Result |
|---|---|---|
| Executor done | Executor returns `{output}` | Output is checked against declared fields and contracts, then persisted as succeeded (`packages/workflow-engine/src/engine.ts:35-38`, `packages/workflow-engine/src/engine.ts:140-145`). |
| Executor wait | Executor returns `{wait, partial?}` | The step is persisted as waiting; optional `poll` can later settle it (`packages/workflow-engine/src/engine.ts:36-38`, `packages/workflow-engine/src/engine.ts:72-74`). |
| Missing executor registration | Preflight finds no executor key or no registered implementation | Preflight returns a problem; the workflow cannot be started as runnable (`packages/workflow-engine/src/engine.ts:210-220`). |
| Invalid output | Declared-field or contract check fails | The step fails with `output_invalid`, then the run fails and open sibling steps are canceled (`packages/workflow-engine/src/engine.ts:139-145`, `packages/workflow-engine/src/engine.ts:1290-1295`, `packages/workflow-engine/src/engine.ts:525-534`). |
| Executor or routing error | Executor throws, a route has no matching edge, or an expression reference is missing | Step/run failure records a reason; route errors become `RouteFailure` reasons (`packages/workflow-engine/src/engine.ts:124-125`, `packages/workflow-engine/src/engine.ts:921-925`, `packages/workflow-engine/src/engine.ts:938-940`). |
| Admission denied / disposed | `admit` returns false or engine is disposed | Driver stops at a step boundary and reports `stopped`, leaving work for the next engine instance (`packages/workflow-engine/src/engine.ts:81-84`, `packages/workflow-engine/src/engine.ts:104-106`). |
| Reloaded run | Existing run row plus `resumePolicy` and compatibility stamp | Continue or interrupt according to policy; changed compatibility can prevent unsafe resume (`packages/workflow-engine/src/engine.ts:86-110`). |
| Parallel join | Join policy `all`, `majority`, or `all_or_low_confidence` | Reducer evaluates branch arrivals and produces the join result (`packages/workflow-engine/src/schema.ts:63-64`, `packages/workflow-engine/src/reducers.ts:33-92`). |

## Business rules

- Step output is filtered to declared fields and checked against `produces` and `gates`; a contract problem prevents the step from completing (`packages/workflow-engine/src/engine.ts:139-145`).
- Journal step transitions are allow-listed and written conditionally; a competing writer that finds the step in another state gets a logged refusal (`packages/workflow-engine/src/journal.ts:114-121`, `packages/workflow-engine/src/journal.ts:162-178`).
- `running -> pending` is allowed for reentrant step recovery; terminal step states have no outgoing transitions (`packages/workflow-engine/src/journal.ts:114-121`).
- When usage is unknown for a token- or money-budgeted run, the engine uses a floor of 40 steps and two hours as bounds (`packages/workflow-engine/src/engine.ts:30-34`).
- Compatibility is distinct from package release version; `ENGINE_COMPAT_VERSION` is the stamp compared when deciding whether an in-flight step can resume (`packages/workflow-engine/src/engine.ts:86-93`, `packages/workflow-engine/src/engine.ts:165-166`).

## Public API

| Import | Purpose |
|---|---|
| `WorkflowEngine`, `EngineOptions`, `StepContext`, `NodeExecutor`, `RunSummary` | Configure, register, start, stop, and inspect execution (`packages/workflow-engine/src/engine.ts:18-121`, `packages/workflow-engine/src/engine.ts:151-210`). |
| `createJournal`, `workflowMigrations`, `STEP_TRANSITIONS` | Journal storage and migration definitions (`packages/workflow-engine/src/journal.ts:10-12`, `packages/workflow-engine/src/journal.ts:114-121`, `packages/workflow-engine/src/journal.ts:150-192`). |
| `lowerWorkflow`, `registerPureActions`, `registerReducers` | Lower workflow syntax and register built-in deterministic execution (`packages/workflow-engine/src/lower.ts:52-101`, `packages/workflow-engine/src/actions.ts:183-198`, `packages/workflow-engine/src/reducers.ts:122-129`). |

## Package shape

Execution is implemented by `engine.ts`, with graph expansion in `lower.ts`, durable transitions in `journal.ts`, deterministic actions and reducers in `actions.ts` and `reducers.ts`, and expression/value evaluation in `expr.ts` and `values.ts` (`packages/workflow-engine/src/engine.ts:1-16`, `packages/workflow-engine/src/lower.ts:1-10`).

## Internal model

An executor is the boundary between graph scheduling and work owned by the host. The engine supplies mapped inputs and helpers through `StepContext`; it does not implement integrations such as agent execution itself (`packages/workflow-engine/src/engine.ts:42-74`).

Run and step state are durable records. The engine serializes workflow definition and outputs into the journal; effect intent/result rows let integrations reconcile external work (`packages/workflow-engine/src/journal.ts:11-105`).

## Dependencies

The engine consumes the workspace's schema, expression, validation, lowering, output, contracts, goals, and journal modules. `LanePilotDatabase` is a `better-sqlite3` handle (`packages/workflow-engine/src/engine.ts:1-16`, `packages/workflow-engine/src/db.ts:1-4`).

## Gotchas

- An executor that performs external writes outside `ctx.effect` cannot use the engine’s recorded intent/outcome path for restart reconciliation (`packages/workflow-engine/src/engine.ts:64-65`).
- A `waiting` step needs a polling strategy or external settlement path to leave that state (`packages/workflow-engine/src/engine.ts:72-74`, `packages/workflow-engine/src/journal.ts:114-121`).

## Engine setup and registration details

### `WorkflowEngine`

Construction chooses the clock, creates a journal bound to the supplied database and event callback, assigns the caller's instance ID or a generated one, chooses the lease duration, and registers built-in executors (`packages/workflow-engine/src/engine.ts:151-174`). `register` replaces the executor stored under a key and returns the engine for chaining; `hasExecutor` checks that map (`packages/workflow-engine/src/engine.ts:176-177`).

Before execution, `preflight` validates the workflow, lowers it, skips note nodes, and checks that every remaining node resolves to an executor key that is registered. It returns a list of problems; it does not start a run (`packages/workflow-engine/src/engine.ts:210-220`).

On first use of a run, `compiled` parses the journal's stored definition and caches a compiled graph. `compile` indexes non-note nodes, groups outgoing edges by source, parses non-start edge conditions and node `skip_when` expressions, and indexes join nodes by their parallel ID. Repeated reads reuse the cached form (`packages/workflow-engine/src/engine.ts:189-207`). Invalid definitions are rejected by preflight/load validation; expression evaluation can later fail on missing values or type errors, which the driver turns into a run failure (`packages/workflow-engine/src/engine.ts:210-220`, `packages/workflow-engine/src/engine.ts:921-925`).

At runtime, executor results branch into completed output, external wait, or failure; outputs are checked against declared fields/contracts before a step succeeds. Failed runs cancel still-open pending/waiting steps, while engine bugs and process shutdown follow interruption/recovery paths (`packages/workflow-engine/src/engine.ts:35-38`, `packages/workflow-engine/src/engine.ts:139-145`, `packages/workflow-engine/src/engine.ts:525-534`).

### `pureActionExecutor`

`pureActionExecutor(key)` looks up the implementation in the fixed `ACTIONS` map and returns a reentrant executor. For `verdict.aggregate`, input references always use `AGGREGATE_READS`; other actions use `node.reads` or an empty list. It invokes the action with the node, `params` defaulting to `{}`, an indexed resolver through `ctx.resolve`, and the full step context, then returns `output` plus `detail` only when present (`packages/workflow-engine/src/actions.ts:176-192`).

An unrecognized key has no explicit guard: the non-null assertion is erased at runtime, so calling the returned executor attempts `action.run` on an absent map entry and throws. Registered keys are exported in `PURE_ACTION_KEYS`; `registerPureActions` registers one executor per key (`packages/workflow-engine/src/actions.ts:183-198`). Errors from the action implementation propagate through the attempt loop, are retried up to `maxAttempts`, then fail the step/run (`packages/workflow-engine/src/engine.ts:790-827`).

### `registerReducers`

The function iterates every `[key, reduce]` pair in `REDUCERS` and registers an asynchronous reentrant executor. At invocation it reads `results`, `failed`, `rows`, and `items` from `ctx.input.with`, substituting an empty array for each missing value; it passes those arrays to the reducer and wraps the returned record as step `output` (`packages/workflow-engine/src/reducers.ts:11-18`, `packages/workflow-engine/src/reducers.ts:121-129`).

Reducers are deterministic code that filters, groups, counts, sorts, or deduplicates branch data; they do not call an agent or model (`packages/workflow-engine/src/reducers.ts:33-119`). There is no per-reducer catch or shape validation in the registration wrapper: a reducer exception propagates as executor failure, and a malformed non-array input can fail inside reducer code (`packages/workflow-engine/src/reducers.ts:122-128`).

## Journal construction and migration application

### `createJournal`

The factory closes over the database and clock, then provides `getRun`, `getStep`, and `steps` reads. Its event writer inserts a timeline row before invoking `onEvent`; exceptions from the notification callback are swallowed so they do not undo a journal transition (`packages/workflow-engine/src/journal.ts:150-160`).

`moveStep` first checks the requested transition against `STEP_TRANSITIONS`; an illegal transition throws. It then conditionally updates only rows whose current state is in the caller's `from` set. A stale/missing row returns `false` after recording a refusal event; a successful update records a step event and returns `true` (`packages/workflow-engine/src/journal.ts:162-179`). `setRunStatus` similarly conditionally updates from expected statuses, records a run event on success, and returns false without an event if no row changed (`packages/workflow-engine/src/journal.ts:181-187`). Database errors from writes propagate to the caller.

### `workflowMigrations`

This exported ordered string array defines the run, step, parallel-arrival, external-effect, and event tables, their lookup indexes, and triggers that reject event updates and deletes. The host storage room appends these statements to its ordered migrations; the engine package exports definitions but does not open or migrate a database by itself (`packages/workflow-engine/src/journal.ts:10-105`, `packages/workflow-engine/src/db.ts:1-4`). The table meanings and fields live in the [run journal data model](../data-model/run-journal.md). Migration execution errors are handled by the host migration runner, not caught in this array (`packages/workflow-engine/src/journal.ts:10-105`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](../overview.md)
