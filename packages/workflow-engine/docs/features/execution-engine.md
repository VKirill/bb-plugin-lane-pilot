---
title: Workflow Execution Engine
type: component
created: 2026-10-10
updated: 2026-11-11
status: active
confidence: medium
tags: [workflow-engine, execution, journal]
sources:
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/journal.ts
  - packages/workflow-engine/src/lower.ts
  - packages/workflow-engine/src/quality-mode.ts
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

The engine runs a workflow against caller-provided node executors and persists run, step, join, and effect state in SQLite so the host can resume or inspect work after a process restart (`packages/workflow-engine/src/engine.ts:192-221`, `packages/workflow-engine/src/journal.ts:10-105`).

## How it works

1. The caller constructs `WorkflowEngine` with a database and `harnessVersion`; construction creates the journal and registers built-in executors (`packages/workflow-engine/src/engine.ts:124-150`, `packages/workflow-engine/src/engine.ts:192-216`).
2. The host registers custom executors by key. An executor implements `run`, may declare itself reentrant, and may implement `poll` for waiting steps. Optional `specialistKnown` is passed into preflight validation to reject literal unknown `specialist:<id>` agent roles (`packages/workflow-engine/src/engine.ts:98-104`, `packages/workflow-engine/src/engine.ts:124-150`, `packages/workflow-engine/src/engine.ts:267-277`, `packages/workflow-engine/src/validate.ts:395-403`).
3. At start, workflow nodes are lowered into executable nodes with `lowerWorkflow` and `for_each`/parallel forms; the run stores its workflow identity, version, hash, `definition_json`, mode, inputs, and usage counters (`packages/workflow-engine/src/lower.ts:6`, `packages/workflow-engine/src/engine.ts:287-307`, `packages/workflow-engine/src/journal.ts:11-39`). The children a run may call are resolved once at start — through caller pins, caller `resolve`, then the engine's `resolveWorkflow` — and pinned into the stored definition (`packages/workflow-engine/src/engine.ts:221`, `packages/workflow-engine/src/engine.ts:287-307`).
4. The driver claims pending steps, resolves mapped inputs and references, then calls the selected executor with a `StepContext` containing run/step identity, attempt, goals, input, mode, and effect support (`packages/workflow-engine/src/engine.ts:21-96`).
5. A done result passes declared output fields and node contracts; a wait result persists partial output and wait details; thrown step errors move the step and run to failure unless classified as an engine bug; if the plugin is stopping, the attempt remains running for reload recovery (`packages/workflow-engine/src/engine.ts:65-67`, `packages/workflow-engine/src/engine.ts:180-186`, `packages/workflow-engine/src/engine.ts:943-953`).
6. Completed branches route through graph edges and joins; `event` rows accompany transitions. External side effects use `ctx.effect` to record intent and outcome for restart reconciliation (`packages/workflow-engine/src/journal.ts:156-160`, `packages/workflow-engine/src/engine.ts:97`).

## Modes and states

| Branch | Inputs or condition | Result |
|---|---|---|
| Executor done | Executor returns `{output}` | Output is checked against declared fields and contracts, then persisted as succeeded (`packages/workflow-engine/src/engine.ts:65-67`, `packages/workflow-engine/src/engine.ts:180-191`). |
| Executor wait | Executor returns `{wait, partial?}` | The step is persisted as waiting; optional `poll` can later settle it (`packages/workflow-engine/src/engine.ts:105`, `packages/workflow-engine/src/engine.ts:105`). |
| Missing executor registration | Preflight finds no executor key or no registered implementation | Preflight returns a problem; the workflow cannot be started as runnable (`packages/workflow-engine/src/engine.ts:267-277`). |
| Invalid output | A completed executor result fails declared-field checks or its artifact/gate contract | `checkOutput` throws `output_invalid` for a non-object, a missing required field other than `handoff`, or an invalid field type; a missing/empty `handoff` uses `handoff_missing` (`packages/workflow-engine/src/values.ts:30-44`). Contract failures use `artifact_invalid` or `gate_failed` (`packages/workflow-engine/src/engine.ts:180-191`). After retries, `failStep` and `failRun` mark the run failed (`packages/workflow-engine/src/engine.ts:590-646`). |
| Executor or routing error | Executor throws, a route has no matching edge, or an expression reference is missing | Step/run failure records a reason; route errors become `RouteFailure` reasons (`packages/workflow-engine/src/engine.ts:165`, `packages/workflow-engine/src/engine.ts:1067-1085`). |
| Admission denied / disposed | `admit` returns false or engine is `stopped` | Driver stops at a step boundary and reports `stopped`, leaving work for the next engine instance (`packages/workflow-engine/src/engine.ts:139`, `packages/workflow-engine/src/engine.ts:240`, `packages/workflow-engine/src/engine.ts:844-845`). |
| Reloaded or periodically resumed run | Existing run row, whether this engine still holds its runtime, `resumePolicy`, executor reentrancy, and compatibility stamp | A held runtime bypasses `resumePolicy`; otherwise `interrupt` policy ends running/waiting work, while continuation resets a running step to pending only for a reentrant, compatible executor (`packages/workflow-engine/src/engine.ts:1385-1419`). |
| Plugin stops during a step error | Attempt fails while the engine is stopping | The step remains `running` for reload recovery; a reentrant step is retried by spawn key, while a non-reentrant step is interrupted (`packages/workflow-engine/src/engine.ts:943-953`, `packages/workflow-engine/src/engine.ts:1394-1415`). |
| Parallel join | Join policy `all`, `majority`, or `all_or_low_confidence` | Reducer evaluates branch arrivals and produces the join result (`packages/workflow-engine/src/schema.ts:64`, `packages/workflow-engine/src/reducers.ts:33-150`). |
| Any budget limit reached before built-in `emit` or a node skipped by `skip_when`/quality mode | `checkLimits` reports a `budget_exceeded:*` reason (`packages/workflow-engine/src/engine.ts:674-685`); an `emit` node or one whose `skipReason` says it will be skipped counts as paid for (`packages/workflow-engine/src/engine.ts:864-873`, `packages/workflow-engine/src/engine.ts:827-833`). | The engine records one `budget_overrun` event and lets the no-spend node complete; other pending nodes block the run (`packages/workflow-engine/src/engine.ts:870-873`). |

## Business rules

- Step output is filtered to declared fields and checked against `produces` and `gates`; a contract problem prevents the step from completing (`packages/workflow-engine/src/engine.ts:180-191`).
- Journal step transitions are allow-listed and written conditionally; a competing writer that finds the step in another state gets a logged refusal (`packages/workflow-engine/src/journal.ts:116-122`, `packages/workflow-engine/src/journal.ts:163-180`).
- `running -> pending` is allowed for reentrant step recovery; terminal step states have no outgoing transitions (`packages/workflow-engine/src/journal.ts:116-122`).
- A run has no step-count budget. `guards.maxSteps` defaults to 500 and stops an engine run that reaches its guard; token and cost limits use reported usage, and a token/cost-budgeted run with unknown usage gets a two-hour wall-time bound unless `budget.maxWallSeconds` is set (`packages/workflow-engine/src/schema.ts:302-313`, `packages/workflow-engine/src/engine.ts:666-673`, `packages/workflow-engine/src/engine.ts:1206`).
- Spend survives failed tries: `spentBefore` accumulates failed-attempt usage (`packages/workflow-engine/src/engine.ts:922-948`), then the total is charged after success or final failure (`packages/workflow-engine/src/engine.ts:964-976`).
- `runVotes` carries rejected executor spend in `failedSpend` into its result; a majority error carries that usage (`packages/workflow-engine/src/engine.ts:1015-1027`).
- A failed child run's accumulated usage is added to its parent once, with a `child_usage_charged` event guarding the charge across reloads (`packages/workflow-engine/src/engine.ts:1362-1365`).
- Before a run closes, `closeAfterAudit` judges a run with goals against them: all met closes `succeeded`, unmet goals close `blocked` with the unmet ids (`packages/workflow-engine/src/engine.ts:450-502`). A workflow whose definition declares `goal_audit: "required"` — a user workflow — closes `not_verified` instead of `succeeded` when it reaches its exit with no goals, or when the audit could not be made (`packages/workflow-engine/src/engine.ts:453-463`, `packages/workflow-engine/src/engine.ts:488-493`; the `goal_audit` field at `packages/workflow-engine/src/schema.ts:324`; the status values in the [run journal data model](../data-model/run-journal.md)).
- A `goal_audit: required` workflow started without goals — from the PM's tool, a trigger, or a schedule — gets one request goal built from the `title` or `text` input via `requestGoals`, so the audit judges the owner's request (`packages/workflow-engine/src/engine.ts:152-157`, `packages/workflow-engine/src/engine.ts:303`).
- The run's quality mode is resolved once at start through the contract → node → workflow → project order; a contract or explicit `quality_mode: full` input on a workflow whose mode is `fixed: quick` is rejected with `quality_mode_conflict`, not run as quick (`packages/workflow-engine/src/engine.ts:307-312`; the resolution order on [Workflow Quality and Contracts](quality-contracts.md)).
- `cancel` transitions an active run to `canceled` via `setRunStatus`, aborts its active controller, cancels open steps with `cancelOpenSteps`, and queries child runs by `parent_run_id` to cancel each child recursively (`packages/workflow-engine/src/engine.ts:1520-1525`).
- A finished run releases its abort controller at once and keeps its compiled graph and runtime until `RETAINED_RUNS` (64) newer runs have finished; a re-run of an older run rebuilds what was dropped (`packages/workflow-engine/src/engine.ts:38`, `packages/workflow-engine/src/engine.ts:351-362`).
- `rerunNode` accepts only terminal top-level runs and a previously-run, inactive node; it resets that node and downstream work. Its optional `patch` merges corrected fields over the target step's prior mapped inputs, and the rerun event records the patched keys (`packages/workflow-engine/src/engine.ts:1525-1535`, `packages/workflow-engine/src/engine.ts:1560-1586`).
- A built-in `emit` step or a node skipped by quality mode/`skip_when` can pass after a budget limit (`packages/workflow-engine/src/engine.ts:870-873`, `packages/workflow-engine/src/engine.ts:875-884`); the engine records `budget_overrun` once per run (`packages/workflow-engine/src/engine.ts:870-871`). A node whose `skip_when` expression errors is not treated as free (`packages/workflow-engine/src/engine.ts:827-839`).
- Compatibility is distinct from package release version; `ENGINE_COMPAT_VERSION` is the stamp compared when deciding whether an in-flight step can resume (`packages/workflow-engine/src/engine.ts:120-123`).
- Agent prompt coverage validation warns when produced-artifact schema enums are absent from both the prompt and generated output contract; it does not block preflight because it is a warning (`packages/workflow-engine/src/prompt-coverage.ts:17-31`, `packages/workflow-engine/src/validate.ts:402`).

## Public API

| Import | Purpose |
|---|---|
| `WorkflowEngine`, `EngineOptions`, `StepContext`, `NodeExecutor`, `RunSummary` | Configure, register, start, stop, and inspect execution (`packages/workflow-engine/src/engine.ts:21-150`, `packages/workflow-engine/src/engine.ts:192-265`). |
| `WorkflowEngine.rerunNode(runId, nodeId, runtime?, patch?)` | Restart a previously-run node and downstream steps in a terminal top-level run; optional runtime replaces run runtime and `patch` merges corrected values into the target step's mapped input (`packages/workflow-engine/src/engine.ts:1525-1535`, `packages/workflow-engine/src/engine.ts:1560-1586`). |
| `requestGoals(inputs)` | The request goal a `goal_audit: required` workflow started without goals is judged by (`packages/workflow-engine/src/engine.ts:152-157`). |
| `createJournal`, `workflowMigrations`, `STEP_TRANSITIONS` | Journal storage and migration definitions (`packages/workflow-engine/src/journal.ts:10-12`, `packages/workflow-engine/src/journal.ts:116-122`, `packages/workflow-engine/src/journal.ts:151-191`). |
| `lowerWorkflow`, `registerPureActions`, `registerReducers` | Lower workflow syntax, including `for_each`, and register built-in deterministic execution (`packages/workflow-engine/src/lower.ts:5-9`, `packages/workflow-engine/src/actions.ts:205`, `packages/workflow-engine/src/reducers.ts:152-160`). |

## Package shape

Execution is implemented by `engine.ts`, with graph expansion in `lower.ts`, durable transitions in `journal.ts`, deterministic actions and reducers in `actions.ts` and `reducers.ts`, and expression/value evaluation in `expr.ts` and `values.ts` (`packages/workflow-engine/src/engine.ts:1-16`, `packages/workflow-engine/src/lower.ts:1-10`).

## Internal model

An executor is the boundary between graph scheduling and work owned by the host. The engine supplies mapped inputs and helpers through `StepContext`; it does not implement integrations such as agent execution itself (`packages/workflow-engine/src/engine.ts:72-104`).

Run and step state are durable records. The engine serializes workflow definition and outputs into the journal; effect intent/result rows let integrations reconcile external work (`packages/workflow-engine/src/journal.ts:11-105`).

## Dependencies

The engine consumes the workspace's schema, expression, validation, lowering, output, contracts, goals, quality-mode, and journal modules, and accepts a `better-sqlite3` database handle (`packages/workflow-engine/src/engine.ts:1-16`, `packages/workflow-engine/src/engine.ts:126-127`).

## Gotchas

- An executor that performs external writes outside `ctx.effect` cannot use the engine’s recorded intent/outcome path for restart reconciliation (`packages/workflow-engine/src/engine.ts:97`).
- A `waiting` step needs a polling strategy or external settlement path to leave that state (`packages/workflow-engine/src/engine.ts:104`, `packages/workflow-engine/src/journal.ts:116-122`).

## Engine setup and registration details

### `WorkflowEngine`

Detailed construction, compilation, preflight, journal transitions, and pure action execution branches are in [Engine, Journal, and Pure Action Details](engine-journal-actions.md). Reducer branch outputs and runtime internals are expanded in [Workflow Execution Runtime Internals](execution-runtime-internals.md).

How `WorkflowEngine` works (`packages/workflow-engine/src/engine.ts:192-265`):
1. **Construction**: `constructor` takes `EngineOptions` (`db`, `harnessVersion`, optional `compatVersion`, `leaseMs` defaulting to 90s, `instanceId`, `now`, `onEvent`), creates a `Journal` with `createJournal(options.db, this.now, options.onEvent)`, and registers built-in executors via `registerBuiltins()` (`packages/workflow-engine/src/engine.ts:222-228`).
2. **Registration**: `register(key, executor)` stores the executor in `executors` and returns `this` for chaining; `hasExecutor(key)` checks whether a key is present, and `resolveWorkflow` resolves subworkflows through the engine (`packages/workflow-engine/src/engine.ts:230-233`).
3. **Attempt tracking**: `spawnKeyOf(runId, step, attempt)` hashes `runId|step_key|attempt|rerun` to a 32-character SHA-256 hex key for reproducible agent threads (`packages/workflow-engine/src/engine.ts:235-238`).
4. **Compilation**: `compile(wf)` filters out `note` nodes, groups outgoing edges by source, parses edge `when` conditions and node `skip_when` into ASTs via `toExpr`, and indexes join nodes by parallel ID (`packages/workflow-engine/src/engine.ts:245-256`). `compiled(run)` deserializes `definition_json` and caches the `Compiled` instance in `compiledRuns` (`packages/workflow-engine/src/engine.ts:259-263`).
- **Conditions and modes**: The compatibility stamp resolves `options.compatVersion ?? options.harnessVersion` (`packages/workflow-engine/src/engine.ts:219`); `stopped()` checks `disposed` or `options.isDisposed()` (`packages/workflow-engine/src/engine.ts:240`).
- **Outcomes and failures**: Construction creates a ready engine. Parsing invalid JSON or malformed expressions in stored definitions throws syntax errors on first use (`packages/workflow-engine/src/engine.ts:259-263`).

### `pureActionExecutor`

How `pureActionExecutor` works (`packages/workflow-engine/src/actions.ts:194-204`):
1. **Lookup**: Resolves `action = ACTIONS[key]!` and returns a reentrant `NodeExecutor` (`packages/workflow-engine/src/actions.ts:194-196`).
2. **Reference selection**: For `key === "verdict.aggregate"`, sets `refs` to `AGGREGATE_READS` (`["dims.findings", "confirm.dropped_ids", "dims.unchecked", "spec_check.unmet_count", "prepass.findings"]`); for other actions, reads `node.reads ?? []` (`packages/workflow-engine/src/actions.ts:189-199`).
3. **Execution**: Invokes `action.run` with `node`, defaulted `params: node.params ?? {}`, a positional `read(index)` resolver that calls `ctx.resolve(refs[index])`, and `ctx` (`packages/workflow-engine/src/actions.ts:199`).
4. **Result packaging**: Returns `{ output: result.output, ...(result.detail !== undefined ? { detail: result.detail } : {}) }` (`packages/workflow-engine/src/actions.ts:200`).
- **Conditions and modes**: Branches on action key to select hardcoded aggregate references versus node-declared reads (`packages/workflow-engine/src/actions.ts:197-198`).
Includes `detail` only when the action returns it (`packages/workflow-engine/src/actions.ts:200`).
- **Outcomes and failures**: Returns validated output dictionary. An unrecognized key attempts `action.run` on an undefined map entry and throws a `TypeError` at runtime (`packages/workflow-engine/src/actions.ts:195-199`); thrown errors are caught by the attempt runner and retried up to `maxAttempts` before failing the step (`packages/workflow-engine/src/engine.ts:923-950`).

### `registerReducers` and `REDUCERS`

How `REDUCERS` works (`packages/workflow-engine/src/reducers.ts:33-150`):
1. **Input extraction**: `registerReducers` extracts branch `results`, `failed`, `rows`, and `items` from `ctx.input.with` and wraps reducer output into step output (`packages/workflow-engine/src/reducers.ts:11-18`, `packages/workflow-engine/src/reducers.ts:152-160`).
2. **Row partitioning**: `done(input)` collects successful rows; `lost(input)` collects failed rows (`packages/workflow-engine/src/reducers.ts:19-24`).
3. **Domain reduction**: Reducers evaluate branch rows and produce aggregated outputs (`packages/workflow-engine/src/reducers.ts:33-150`).
- **Conditions and modes**:
  - `reduce.billing-batch.invoices`: maps invoice numbers and non-empty PDF paths from completed branches (`packages/workflow-engine/src/reducers.ts:34-40`).
  - `reduce.insights-post.posts`: filters done rows with `data.status === "ok"`; reports ok folders, summary paths, and ok/failed counts (`packages/workflow-engine/src/reducers.ts:41-44`).
  - `reduce.issue-discover.scan`: flattens `findings` lists across results and counts findings (`packages/workflow-engine/src/reducers.ts:45`).
  - `reduce.issue-quick.review`: returns flattened findings, critical/high counts, branch failure count, and a comment that appends a failure note when `input.failed` is nonempty (`packages/workflow-engine/src/reducers.ts:46-54`).
  - `reduce.debug.diagnose`: returns one diagnosis per row, taking the gap from the item's `gap`, `text`, or raw value; successful rows include root cause, confidence, and status, while failed rows include an error (`packages/workflow-engine/src/reducers.ts:55-59`).
  - `reduce.lp.brainstorm.designs`: keeps rows where `data.ok !== false`; collects digests and records failed roles from lost/false branches (`packages/workflow-engine/src/reducers.ts:60-64`).
  - `reduce.lp.build.run_tasks`: branches on `row.ok` and `data.state` into `accepted_ids` (and merged commits), `blocked_ids` (`blocked` or `needs_human`), or `failed_ids` with verdict findings (`packages/workflow-engine/src/reducers.ts:75-87`).
  - `reduce.lp.review.dims`: flattens findings, adds deterministic IDs (`findingId`), sorts by severity (`critical` to `info`), and counts critical/high findings (`packages/workflow-engine/src/reducers.ts:88-94`).
  - `reduce.lp.review.confirm`: keeps finding IDs confirmed unless the branch succeeded and returned `confirmed === false` (`packages/workflow-engine/src/reducers.ts:95-103`).
  - `reduce.reels.render`: collects rendered file paths and failed IDs (`packages/workflow-engine/src/reducers.ts:105-108`).
  - `reduce.reels.verify`: aggregates ok counts, bad files from failed branches, and flattened issues (`packages/workflow-engine/src/reducers.ts:109-112`).
  - `reduce.roadmap-driven.sessions`: partitions branches by `data.status === "done"` into `done_ids` versus `blocked_ids` (`packages/workflow-engine/src/reducers.ts:113-117`).
- **Outcomes and failures**: Produces dictionary output for parallel join steps. Missing input rows default to empty lists or records without throwing.

### `checkStepOutput`

The engine passes the node, its declared output fields, and the returned output. When fields are known, `checkOutput` requires a non-array object, checks required values and field types, and returns only declared fields. When fields are `unknown`, this filter is skipped and the original output proceeds to contract checks (`packages/workflow-engine/src/engine.ts:180-191`, `packages/workflow-engine/src/values.ts:30-44`).

`contractProblems` calls `checkProduces` for declared artifacts and evaluates each gate against the current node's output; a false gate or an evaluation failure becomes a gate problem. If any contract problem exists, `checkStepOutput` throws `MissingValueError`: code `artifact_invalid` when the produces list has problems, otherwise `gate_failed`, with all problem descriptions joined into the message. With no problems it returns the kept output (`packages/workflow-engine/src/contract.ts:26-40`, `packages/workflow-engine/src/engine.ts:180-191`).

The executor path catches this error as an attempt failure and, after retries are exhausted, fails the step/run with the error code. Output returned by an external settlement is also checked; a check failure moves that waiting step to failed and fails the run (`packages/workflow-engine/src/engine.ts:923-950`, `packages/workflow-engine/src/engine.ts:1483-1490`).

## Journal construction and migration application

### `createJournal`

How `createJournal` works (`packages/workflow-engine/src/journal.ts:151-191`):
1. **Initialization**: Closes over `db: Database.Database`, `now: () => number`, and optional `onEvent: (runId: string) => void` (`packages/workflow-engine/src/journal.ts:151`).
2. **Readers**: Provides `getRun(id)` querying `lane_pilot_wf_run`, `getStep(runId, stepKey)` querying `lane_pilot_wf_step`, and `steps(runId)` returning all steps ordered by `rowid` (`packages/workflow-engine/src/journal.ts:152-154`).
3. **Event recording**: `event(runId, stepKey, kind, from, to, detail)` inserts an append-only row into `lane_pilot_wf_event`, then calls `onEvent(runId)` inside `try/catch` (`packages/workflow-engine/src/journal.ts:156-161`).
4. **Step state transition**: `moveStep(runId, stepKey, from, to, patch)` checks `from -> to` against `STEP_TRANSITIONS`, updates state, `updated_at`, patch fields, and optional `started_at`/`ended_at`, then executes an atomic UPDATE `WHERE run_id=? AND step_key=? AND state IN (...)` (`packages/workflow-engine/src/journal.ts:163-180`).
5. **Run status transition**: `setRunStatus(runId, from, to, reason, extra)` executes an atomic UPDATE `WHERE id=? AND status IN (...)` (`packages/workflow-engine/src/journal.ts:182-188`).
- **Conditions and modes**: In `moveStep`, throws if `to` is not in `STEP_TRANSITIONS[from]` (`packages/workflow-engine/src/journal.ts:167`). If 0 rows match the conditional UPDATE, records a `refused` event and returns `false`; on match, records a `step` event and returns `true` (`packages/workflow-engine/src/journal.ts:177-179`). In `setRunStatus`, returns `false` if 0 rows match; otherwise records a `run` event and returns `true` (`packages/workflow-engine/src/journal.ts:185-187`).
- **Outcomes and failures**: Guarantees atomic, audited transitions. Listener errors in `onEvent` are swallowed so UI callbacks never roll back database updates (`packages/workflow-engine/src/journal.ts:159-160`).

### `STEP_TRANSITIONS`

How `STEP_TRANSITIONS` works (`packages/workflow-engine/src/journal.ts:116-123`):
1. **Transition mapping**: Maps each of the 8 step states to an allow-list of valid target states (`packages/workflow-engine/src/journal.ts:116-122`).
2. **Validation**: Used by `moveStep` to validate every transition before issuing updates (`packages/workflow-engine/src/journal.ts:164-168`).
- **Conditions and modes**:
  - `pending`: can move to `running` (driver dispatch), `skipped` (`skip_when` or mode skip), or `canceled` (run failure/abort) (`packages/workflow-engine/src/journal.ts:117`).
  - `running`: can move to `succeeded` (output validated), `failed` (executor error), `waiting` (wait returned), `interrupted` (reload/stale lease), `canceled` (run canceled), or `pending` (reentrant retry) (`packages/workflow-engine/src/journal.ts:118`).
  - `waiting`: can move to `succeeded` (settlement), `failed` (timeout or poll failure), `canceled`, or `interrupted` (`packages/workflow-engine/src/journal.ts:119`).
  - `interrupted`: can move to `running` (resumed on restart) or `canceled` (`packages/workflow-engine/src/journal.ts:120`).
  - `succeeded`, `failed`, `skipped`, `canceled`: terminal states with empty transition arrays `[]` (`packages/workflow-engine/src/journal.ts:121`).
- **Outcomes and failures**: Enforces forward step progress, allowing backward transition only for `running -> pending` on reentrant reloads. Any transition out of a terminal state or absent from the list throws `illegal workflow step transition <from> -> <to>` (`packages/workflow-engine/src/journal.ts:167`).

### `workflowMigrations`

`workflowMigrations` exports the SQLite DDL statements applied by host migrations before engine startup (`packages/workflow-engine/src/journal.ts:10`). Run and step table schemas, fields, and constraints are documented in [Workflow Run Journal Data](../data-model/run-journal.md), while migration statements are detailed in [Workflow Execution Engine Internals](execution-engine-internals.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Definitions and Validation](definitions-validation.md)
- [Engine, Journal, and Pure Action Details](engine-journal-actions.md)
- [Workflow Execution Engine Internals](execution-engine-internals.md)
- [Workflow Execution Runtime Internals](execution-runtime-internals.md)
- [Workflow Validation and Expression Internals](workflow-validation-internals.md)
- [Workflow Engine — Overview](../overview.md)
