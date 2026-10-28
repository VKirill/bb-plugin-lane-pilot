---
title: Workflow Execution Engine
type: component
created: 2026-10-10
updated: 2026-10-28
status: active
confidence: medium
tags: [workflow-engine, execution, journal]
sources:
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/db.ts
  - packages/workflow-engine/src/journal.ts
  - packages/workflow-engine/src/lower.ts
  - packages/workflow-engine/src/schema.ts
  - packages/workflow-engine/src/contract.ts
  - packages/workflow-engine/src/expr.ts
  - packages/workflow-engine/src/values.ts
  - packages/workflow-engine/src/actions.ts
  - packages/workflow-engine/src/reducers.ts
  - packages/workflow-engine/src/validate.ts
  - packages/workflow-engine/src/prompt-coverage.ts
---
# Workflow Execution Engine
TL;DR: `WorkflowEngine` drives lowered workflow graphs by claiming journaled steps, calling registered executors, validating outputs, and recording completion, waits, or failures.

## Purpose

The engine runs a workflow against caller-provided node executors and persists run, step, join, and effect state in SQLite so the host can resume or inspect work after a process restart (`packages/workflow-engine/src/engine.ts:151-177`, `packages/workflow-engine/src/journal.ts:10-105`).

## How it works

1. The caller constructs `WorkflowEngine` with a database and `harnessVersion`; construction creates the journal and registers built-in executors (`packages/workflow-engine/src/engine.ts:94-118`, `packages/workflow-engine/src/engine.ts:168-174`).
2. The host registers custom executors by key. An executor implements `run`, may declare itself reentrant, and may implement `poll` for waiting steps. Optional `specialistKnown` is passed into preflight validation to reject literal unknown `specialist:<id>` agent roles (`packages/workflow-engine/src/engine.ts:68-74`, `packages/workflow-engine/src/engine.ts:94-105`, `packages/workflow-engine/src/engine.ts:210-220`, `packages/workflow-engine/src/validate.ts:357-365`).
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
| Invalid output | A completed executor result fails declared-field checks or its artifact/gate contract | `checkOutput` throws `output_invalid` for a non-object, a missing required field other than `handoff`, or an invalid field type; a missing/empty `handoff` uses `handoff_missing`. Contract failures use `artifact_invalid` or `gate_failed`. After retries, a non-tolerated failure marks the run failed, cancels pending/waiting steps, and aborts sibling work; a tolerated parallel-child failure becomes a failed arrival (`packages/workflow-engine/src/values.ts:30-43`, `packages/workflow-engine/src/engine.ts:142-146`, `packages/workflow-engine/src/engine.ts:812-838`, `packages/workflow-engine/src/engine.ts:474-479`, `packages/workflow-engine/src/engine.ts:525-535`). |
| Executor or routing error | Executor throws, a route has no matching edge, or an expression reference is missing | Step/run failure records a reason; route errors become `RouteFailure` reasons (`packages/workflow-engine/src/engine.ts:124-125`, `packages/workflow-engine/src/engine.ts:934-936`, `packages/workflow-engine/src/engine.ts:946-952`). |
| Admission denied / disposed | `admit` returns false or engine is disposed | Driver stops at a step boundary and reports `stopped`, leaving work for the next engine instance (`packages/workflow-engine/src/engine.ts:81-84`, `packages/workflow-engine/src/engine.ts:104-106`). |
| Reloaded run | Existing run row plus `resumePolicy` and compatibility stamp | Continue or interrupt according to policy; changed compatibility can prevent unsafe resume (`packages/workflow-engine/src/engine.ts:86-110`). |
| Parallel join | Join policy `all`, `majority`, or `all_or_low_confidence` | Reducer evaluates branch arrivals and produces the join result (`packages/workflow-engine/src/schema.ts:63-64`, `packages/workflow-engine/src/reducers.ts:33-92`). |
| Cost or token limit reached before built-in `emit` | `checkLimits` reports `budget_exceeded:cost` or `budget_exceeded:tokens`, and the node resolves to `builtin:emit` | The engine records one `budget_overrun` event for the run and runs the emit step so it can pass through mapped output already paid for (`packages/workflow-engine/src/engine.ts:730-735`, `packages/workflow-engine/src/engine.ts:1148-1150`). |

## Business rules

- Step output is filtered to declared fields and checked against `produces` and `gates`; a contract problem prevents the step from completing (`packages/workflow-engine/src/engine.ts:139-145`).
- Journal step transitions are allow-listed and written conditionally; a competing writer that finds the step in another state gets a logged refusal (`packages/workflow-engine/src/journal.ts:114-121`, `packages/workflow-engine/src/journal.ts:162-178`).
- `running -> pending` is allowed for reentrant step recovery; terminal step states have no outgoing transitions (`packages/workflow-engine/src/journal.ts:114-121`).
- When usage is unknown for a token- or money-budgeted run, the engine uses a floor of 40 steps and two hours as bounds (`packages/workflow-engine/src/engine.ts:30-34`).
- If a failed step error carries usage with numeric `tokens`, its token and cost values are added to run totals before the step fails. A failed child run's accumulated usage is added to its parent once, with a `child_usage_charged` event guarding the charge across reloads (`packages/workflow-engine/src/engine.ts:828-838`, `packages/workflow-engine/src/engine.ts:1196-1213`).
- `rerunNode` accepts only terminal top-level runs and a previously-run, inactive node; it resets that node and downstream work, then accepts optional caller runtime that replaces the run's in-memory runtime (`packages/workflow-engine/src/engine.ts:1343-1355`, `packages/workflow-engine/src/engine.ts:1356-1400`).
- A built-in `emit` step can run after a token or cost budget is exceeded; the engine records `budget_overrun` once per run. This exception does not bypass step, wall-time, or unknown-usage limits (`packages/workflow-engine/src/engine.ts:730-735`, `packages/workflow-engine/src/engine.ts:545-555`).
- Compatibility is distinct from package release version; `ENGINE_COMPAT_VERSION` is the stamp compared when deciding whether an in-flight step can resume (`packages/workflow-engine/src/engine.ts:86-93`, `packages/workflow-engine/src/engine.ts:165-166`).
- Agent prompt coverage validation warns when produced-artifact schema enums are absent from both the prompt and generated output contract; it does not block preflight because it is a warning (`packages/workflow-engine/src/prompt-coverage.ts:17-31`, `packages/workflow-engine/src/validate.ts:366-372`).

## Public API

| Import | Purpose |
|---|---|
| `WorkflowEngine`, `EngineOptions`, `StepContext`, `NodeExecutor`, `RunSummary` | Configure, register, start, stop, and inspect execution (`packages/workflow-engine/src/engine.ts:18-121`, `packages/workflow-engine/src/engine.ts:151-210`). |
| `WorkflowEngine.rerunNode(runId, nodeId, runtime?)` | Restart a previously-run node and downstream steps in a terminal top-level run; optional runtime replaces the run runtime (`packages/workflow-engine/src/engine.ts:1337-1400`). |
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

Detailed construction, compilation, preflight, journal transitions, and pure action execution branches are in [Engine, Journal, and Pure Action Details](engine-journal-actions.md).
Reducer branch outputs and the runtime internals of engine setup, journal writes, and pure action dispatch are expanded in [Workflow Execution Runtime Internals](execution-runtime-internals.md).

Construction chooses the clock, creates a journal bound to the supplied database and event callback, assigns the caller's instance ID or a generated one, chooses the lease duration, and registers built-in executors (`packages/workflow-engine/src/engine.ts:151-174`). `register` replaces the executor stored under a key and returns the engine for chaining; `hasExecutor` checks that map (`packages/workflow-engine/src/engine.ts:176-177`).

Before execution, `preflight` validates the workflow, lowers it, skips note nodes, and checks that every remaining node resolves to an executor key that is registered. It returns a list of problems; it does not start a run (`packages/workflow-engine/src/engine.ts:210-220`).

Constructor, executor registration, compilation, and preflight branches are detailed in [Execution engine internals](execution-engine-internals.md) (`packages/workflow-engine/src/engine.ts:169-221`).

On first use of a run, `compiled` parses the journal's stored definition and caches a compiled graph. `compile` indexes non-note nodes, groups outgoing edges by source, parses non-start edge conditions and node `skip_when` expressions, and indexes join nodes by their parallel ID. Repeated reads reuse the cached form (`packages/workflow-engine/src/engine.ts:189-207`). Invalid definitions are rejected by preflight/load validation; expression evaluation can later fail on missing values or type errors, which the driver turns into a run failure (`packages/workflow-engine/src/engine.ts:210-220`, `packages/workflow-engine/src/engine.ts:934-936`).

`renderValue` resolves `{{ref}}` placeholders when the engine maps values. A string consisting of one placeholder keeps the referenced value's type; embedded placeholders produce text, converting objects and arrays to JSON and nullish values to empty text. It recurses through arrays and objects, omitting array entries whose reference resolves to `undefined`. An object containing only `by_mode` selects the current mode's entry or `default`; a missing mode throws `MissingValueError` (`packages/workflow-engine/src/expr.ts:340-362`).

At runtime, executor results branch into completed output, external wait, or failure; outputs are checked against declared fields/contracts before a step succeeds. Failed runs cancel still-open pending/waiting steps, while engine bugs and process shutdown follow interruption/recovery paths (`packages/workflow-engine/src/engine.ts:35-38`, `packages/workflow-engine/src/engine.ts:139-145`, `packages/workflow-engine/src/engine.ts:529-538`).

### `pureActionExecutor`

`pureActionExecutor(key)` looks up the implementation in the fixed `ACTIONS` map and returns a reentrant executor. For `verdict.aggregate`, input references always use `AGGREGATE_READS`; other actions use `node.reads` or an empty list. It invokes the action with the node, `params` defaulting to `{}`, an indexed resolver through `ctx.resolve`, and the full step context, then returns `output` plus `detail` only when present (`packages/workflow-engine/src/actions.ts:176-192`).

The fixed action lookup, read-reference selection, output shape, and failure path are detailed in [Execution engine internals](execution-engine-internals.md) (`packages/workflow-engine/src/actions.ts:176-192`).

An unrecognized key has no explicit guard: the non-null assertion is erased at runtime, so calling the returned executor attempts `action.run` on an absent map entry and throws. Registered keys are exported in `PURE_ACTION_KEYS`; `registerPureActions` registers one executor per key (`packages/workflow-engine/src/actions.ts:183-198`). Errors from the action implementation propagate through the attempt loop, are retried up to `maxAttempts`, then fail the step/run (`packages/workflow-engine/src/engine.ts:794-838`).

### `registerReducers`

The function iterates every `[key, reduce]` pair in `REDUCERS` and registers an asynchronous reentrant executor. At invocation it reads `results`, `failed`, `rows`, and `items` from `ctx.input.with`, substituting an empty array for each missing value; it passes those arrays to the reducer and wraps the returned record as step `output` (`packages/workflow-engine/src/reducers.ts:11-18`, `packages/workflow-engine/src/reducers.ts:121-129`). The shared `done` helper takes successful rows in branch order and defaults missing row data to `{}`; `lost` selects rows whose `ok` is false. Other helpers coerce values to records, lists, and strings, derive IDs from `item.id`, a string item, or `#<branch>`, flatten named arrays, and remove duplicates while preserving first occurrence (`packages/workflow-engine/src/reducers.ts:19-31`).

| Reducer key | Branch condition and output |
|---|---|
| `reduce.insights-post.posts` | Keeps completed rows with `data.status === "ok"`; returns post folders, summary paths, ok count, and total rows minus ok count (`packages/workflow-engine/src/reducers.ts:34-36`). |
| `reduce.issue-discover.scan` | Flattens `findings` from `results`; returns findings and their count (`packages/workflow-engine/src/reducers.ts:38`). |
| `reduce.lp.brainstorm.designs` | Keeps completed rows unless `data.ok === false`; reports digests/count and failed roles from lost rows or explicitly false results (`packages/workflow-engine/src/reducers.ts:39-42`). |
| `reduce.lp.build.run_tasks` | Splits rows into accepted, blocked (`state` blocked or `needs_human`), and failed; failed results contribute verdict findings, accepted results contribute unique merge commits (`packages/workflow-engine/src/reducers.ts:44-55`). |
| `reduce.lp.review.dims` | Flattens findings, adds a stable ID when missing, sorts by severity then original order, and returns critical/high counts plus lost branch items (`packages/workflow-engine/src/reducers.ts:57-62`). |
| `reduce.lp.review.confirm` | Uses the original finding ID; drops a finding only when its row succeeded and `confirmed === false`. Failed checks remain confirmed (`packages/workflow-engine/src/reducers.ts:64-72`). |
| `reduce.reels.render` | Counts completed rows except `ok === false`; returns files and failed IDs from lost or explicitly false rows (`packages/workflow-engine/src/reducers.ts:74-76`). |
| `reduce.reels.verify` | Returns ok count, bad file identifiers from lost/false rows, and flattened issues from successful rows (`packages/workflow-engine/src/reducers.ts:78-80`). |
| `reduce.roadmap-driven.sessions` | A row is done only when `ok` and `data.status === "done"`; every other row is blocked (`packages/workflow-engine/src/reducers.ts:82-85`). |
| `reduce.security-audit.scan` | Flattens findings and warnings; counts critical and high findings (`packages/workflow-engine/src/reducers.ts:87-89`). |
| `reduce.seo-cocoon.evidence` | Excludes completed rows marked `skipped` from findings paths; returns sources and skipped branch names/items from completed skipped or lost rows (`packages/workflow-engine/src/reducers.ts:91-96`). |
| `reduce.seo-cocoon.briefs` | Keeps completed rows with a nonempty brief path and returns paths/count (`packages/workflow-engine/src/reducers.ts:98`). |
| `reduce.web-research.search` | Deduplicates sources by nonempty URL, records completed subquestions with no sources as unavailable, and combines them with lost items (`packages/workflow-engine/src/reducers.ts:99-103`). |
| `reduce.x-to-telegram-digest.score` | Walks scores from completed rows, drops only scores with `keep === false`, resolves each post from score item/post/index or raw score, and returns unique nonempty topics (`packages/workflow-engine/src/reducers.ts:105-117`). |

Reducer input normalization, per-key branches, registration, and failure behavior are detailed in [Execution engine internals](execution-engine-internals.md) (`packages/workflow-engine/src/reducers.ts:10-28`, `packages/workflow-engine/src/reducers.ts:33-128`).

### `checkStepOutput`

The engine passes the node, its declared output fields, and the returned output. When fields are known, `checkOutput` requires a non-array object, checks required values and field types, and returns only declared fields. When fields are `unknown`, this filter is skipped and the original output proceeds to contract checks (`packages/workflow-engine/src/engine.ts:140-145`, `packages/workflow-engine/src/values.ts:29-44`).

`contractProblems` checks declared artifacts and evaluates each gate against the current node's output; a false gate or an evaluation failure becomes a gate problem. If any contract problem exists, `checkStepOutput` throws `MissingValueError`: code `artifact_invalid` when the produces list has problems, otherwise `gate_failed`, with all problem descriptions joined into the message. With no problems it returns the kept output (`packages/workflow-engine/src/contract.ts:25-42`, `packages/workflow-engine/src/engine.ts:140-145`).

The executor path catches this error as an attempt failure and, after retries are exhausted, fails the step/run with the error code. Output returned by an external settlement is also checked; a check failure moves that waiting step to failed and fails the run (`packages/workflow-engine/src/engine.ts:811-831`, `packages/workflow-engine/src/engine.ts:1293-1299`).

## Journal construction and migration application

### `createJournal`

The factory closes over the database and clock, then provides `getRun`, `getStep`, and `steps` reads. Its event writer inserts a timeline row before invoking `onEvent`; exceptions from the notification callback are swallowed so they do not undo a journal transition (`packages/workflow-engine/src/journal.ts:150-160`).

`moveStep` first checks the requested transition against `STEP_TRANSITIONS`; an illegal transition throws. It then conditionally updates only step rows whose current state is in the caller's `from` set. A missing or stale step row returns `false` after recording a refusal event; a successful update records a step event and returns `true` (`packages/workflow-engine/src/journal.ts:162-179`). `setRunStatus` conditionally updates a run from expected statuses, records a run event on success, and returns false without an event if no run row changed (`packages/workflow-engine/src/journal.ts:181-187`). Database errors from writes propagate to the caller.

Read methods, event callbacks, conditional state updates, and refusal/error outcomes are detailed in [Execution engine internals](execution-engine-internals.md) (`packages/workflow-engine/src/journal.ts:150-189`).

### `workflowMigrations`

This export is an ordered array of SQL strings; it does not execute them or open a database (`packages/workflow-engine/src/journal.ts:10-105`, `packages/workflow-engine/src/db.ts:1-4`). Its entries create the run table and indexes, the step table and indexes, arrival and effect tables, then the append-only event table, index, and update/delete rejection triggers (`packages/workflow-engine/src/journal.ts:11-105`).

The DDL sequence, table-specific constraints, and execution boundary are detailed in [Execution engine internals](execution-engine-internals.md) (`packages/workflow-engine/src/journal.ts:10-105`).

The run table constrains run status and stores workflow identity, snapshots, linkage, usage totals, ownership, and timestamps; the step table constrains step state and stores attempt, input/output, wait, receipt, and timing data. Arrival and effect tables constrain their keys, and effect state is checked against its four-state vocabulary. These DDL checks reject invalid status/state values and duplicate constrained keys when the host executes the statements (`packages/workflow-engine/src/journal.ts:11-90`). The table meanings and fields live in the [run journal data model](../data-model/run-journal.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Engine, Journal, and Pure Action Details](engine-journal-actions.md)
- [Workflow Execution Engine Internals](execution-engine-internals.md)
- [Workflow Execution Runtime Internals](execution-runtime-internals.md)
- [Workflow Engine — Overview](../overview.md)
