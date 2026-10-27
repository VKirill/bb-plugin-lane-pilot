---
title: Workflow Execution Runtime Internals
type: component
created: 2026-10-27
updated: 2026-10-27
status: active
confidence: high
tags: [workflow-engine, execution, reducers, journal, actions]
sources:
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/reducers.ts
  - packages/workflow-engine/src/journal.ts
  - packages/workflow-engine/src/actions.ts
---
# Workflow Execution Runtime Internals
TL;DR: The runtime compiles and preflights workflows, journals conditional state changes, and runs deterministic reducer/action executors with explicit branch outputs.

## Purpose

The engine lifecycle overview is in [Workflow Execution Engine](execution-engine.md). This page traces the compiled workflow setup, built-in reducers, journal operations, and pure action dispatch.

## How it works

### `WorkflowEngine` construction, registration, compilation, and preflight

1. Construction selects the supplied clock or `Date.now`, creates a journal bound to the database and event callback, selects a supplied/generated instance ID, sets the lease duration (default 90,000 ms), and registers built-ins (`packages/workflow-engine/src/engine.ts:170-176`).
2. `register(key, executor)` stores or replaces the executor under that key and returns the same engine; `hasExecutor` checks the registry (`packages/workflow-engine/src/engine.ts:178-179`).
3. `compile` builds a map of non-note nodes, groups edges by source while preserving their indexes, parses conditions on non-start edges and each `skip_when`, and maps joins by their parallel node. `compiled` parses `definition_json` and caches that compiled object by run ID on first access (`packages/workflow-engine/src/engine.ts:191-209`).
4. `preflight` validates the workflow (including an optional workflow resolver and specialist lookup), keeps error-level diagnostics, lowers the graph, skips note nodes, and adds a problem when a runnable node has no executor key or the key is not registered (`packages/workflow-engine/src/engine.ts:212-222`).

Preflight returns all discovered problem messages and does not create a run. A bad persisted JSON definition throws during `compiled`; parsing/validation problems and missing executor registrations are reported by preflight (`packages/workflow-engine/src/engine.ts:205-222`). Compilation itself does not catch malformed expression or JSON errors (`packages/workflow-engine/src/engine.ts:191-209`).

### Reducer input normalization and registration

`registerReducers` registers every `REDUCERS` entry as an asynchronous reentrant executor. The wrapper takes `results`, `failed`, `rows`, and `items` from `ctx.input.with`, replacing only missing/nullish values with empty arrays, invokes the selected reducer, and returns its record as `output` (`packages/workflow-engine/src/reducers.ts:11-18`, `packages/workflow-engine/src/reducers.ts:121-129`).

Shared helpers treat non-array lists as empty, non-string text as empty, non-record values as `{}`, and missing successful-row data as `{}`. `done` selects successful rows in input order and retains branch/item/data; `lost` selects rows whose `ok` is false. Reducer failures are not caught by the wrapper (`packages/workflow-engine/src/reducers.ts:19-28`, `packages/workflow-engine/src/reducers.ts:121-129`).

| Key | Branch rules and output |
|---|---|
| `reduce.insights-post.posts` | Selects successful rows whose `data.status` is `ok`; emits folder and summary paths, success count, and all remaining rows as failures (`packages/workflow-engine/src/reducers.ts:34-37`). |
| `reduce.issue-discover.scan` | Flattens `findings` from result rows and returns the list/count (`packages/workflow-engine/src/reducers.ts:38`). |
| `reduce.lp.brainstorm.designs` | Accepts successful rows unless `data.ok === false`; returns digests, count, and failed roles from lost rows or explicit false results (`packages/workflow-engine/src/reducers.ts:39-43`). |
| `reduce.lp.build.run_tasks` | Failed rows go to blocked or failed by their `blocked` flag. Successful `accepted` rows add IDs and optional merge commits; `blocked`/`needs_human` states are blocked; other states are failed and contribute verdict findings. Commit IDs are deduplicated (`packages/workflow-engine/src/reducers.ts:44-56`). |
| `reduce.lp.review.dims` | Flattens findings, assigns a stable ID when missing, sorts by severity (critical to info, unknown last) while preserving original order for ties, and counts critical/high findings; lost row items become unchecked (`packages/workflow-engine/src/reducers.ts:30-31`, `packages/workflow-engine/src/reducers.ts:57-63`). |
| `reduce.lp.review.confirm` | Keeps the branch item's finding ID (then echoed `finding_id`, then a generated ID). Drops only a successful row explicitly returning `confirmed: false`; lost rows remain confirmed (`packages/workflow-engine/src/reducers.ts:64-73`). |
| `reduce.reels.render` | Successful rows except `ok === false` contribute file paths/count. Lost or explicit-false rows contribute failed IDs (`packages/workflow-engine/src/reducers.ts:74-77`). |
| `reduce.reels.verify` | Returns success count, bad file identifiers from lost or explicit-false rows, and flattened issues from successful rows (`packages/workflow-engine/src/reducers.ts:78-81`). |
| `reduce.roadmap-driven.sessions` | Only a successful row with `data.status === "done"` is done; every other row's derived ID is blocked (`packages/workflow-engine/src/reducers.ts:82-86`). |
| `reduce.security-audit.scan` | Flattens findings and warnings and counts critical/high findings (`packages/workflow-engine/src/reducers.ts:87-90`). |
| `reduce.seo-cocoon.evidence` | Completed non-skipped rows contribute findings paths; all result rows contribute sources; completed skipped and lost rows contribute skipped branch names/items (`packages/workflow-engine/src/reducers.ts:91-97`). |
| `reduce.seo-cocoon.briefs` | Completed rows with a nonempty brief path contribute that path and the count (`packages/workflow-engine/src/reducers.ts:98`). |
| `reduce.web-research.search` | Flattens sources and removes later duplicates with the same nonempty URL. Lost items and successful rows with no sources are reported unavailable (`packages/workflow-engine/src/reducers.ts:99-104`). |
| `reduce.x-to-telegram-digest.score` | Reads scores only from successful rows. `keep === false` drops a score; otherwise item, post, indexed batch item, or raw score is kept in that priority order. Nonempty topics are unique (`packages/workflow-engine/src/reducers.ts:105-119`). |

These reducers return data even when some branch rows failed; the reducer-specific fields preserve that failure information. A malformed non-array `rows` value can fail when a reducer iterates it. Such exceptions reject the executor call and enter the engine's normal retry/failure path (`packages/workflow-engine/src/reducers.ts:44-55`, `packages/workflow-engine/src/reducers.ts:121-129`, `packages/workflow-engine/src/engine.ts:794-831`).

### Journal reads and transitions: `createJournal`

1. The factory closes over the database, clock, and optional `onEvent`; it exposes `getRun`, `getStep`, and ordered `steps` reads (`packages/workflow-engine/src/journal.ts:150-153`).
2. The private event writer inserts a journal event with timestamp and serialized detail, then notifies `onEvent`. A listener exception is swallowed after the database insert (`packages/workflow-engine/src/journal.ts:155-160`).
3. `moveStep` normalizes one/many source states, throws for any transition absent from `STEP_TRANSITIONS`, builds the update from defined patch fields, and optionally stamps started/ended times. Its SQL update is conditional on run, step, and expected state (`packages/workflow-engine/src/journal.ts:162-175`).
4. If no step row changed, it appends a `refused` event and returns false. A successful update appends a `step` event and returns true (`packages/workflow-engine/src/journal.ts:176-179`).
5. `setRunStatus` conditionally updates the run from the expected status set, optionally serializes output, and updates the timestamp. No changed row returns false without an event; a change appends a `run` event and returns true (`packages/workflow-engine/src/journal.ts:181-187`).

Database errors from SQL or event insertion propagate. Event notification errors do not; step refusal is evented while run-status refusal is not (`packages/workflow-engine/src/journal.ts:155-186`).

### Deterministic action dispatch: `pureActionExecutor`

1. Select an implementation from the fixed `ACTIONS` map. The returned executor is marked reentrant; on invocation it takes `ctx.node`, defaults missing `params` to `{}`, and selects references from `AGGREGATE_READS` for `verdict.aggregate` or `node.reads` for other actions (`packages/workflow-engine/src/actions.ts:176-190`).
2. Its indexed `read` callback resolves the selected reference through `ctx.resolve`, returning undefined for an index without a reference. The action receives node, params, reader, and full context (`packages/workflow-engine/src/actions.ts:16-17`, `packages/workflow-engine/src/actions.ts:188-191`).
3. Return the action's `output`; include `detail` only when it is not undefined. An unknown key is not checked before lookup and fails when `action.run` is accessed (`packages/workflow-engine/src/actions.ts:185-192`).

| Key | Input-dependent branch and result |
|---|---|
| `items.dedupe` | Uses the first declared output name to select findings mode. Findings merge same-file same-line or text-overlap matches, retaining higher severity; other items drop bare reposts, group by normalized URL/text, and keep the duplicate with greater summed engagement. Returns findings/merged or items/count (`packages/workflow-engine/src/actions.ts:33-63`). |
| `dag.validate` | Checks session IDs, dependency existence/cycles, and requirement-to-session mappings. Returns `ok`, error strings, and cycle paths; it reports problems in output rather than throwing for invalid graphs (`packages/workflow-engine/src/actions.ts:65-95`). |
| `digest.check` | Checks nonempty digest, quoted text against source items, cited URLs against known item URLs/links, secret-like patterns, and message-part count. Returns deduplicated violations and parts; over eight parts is a violation (`packages/workflow-engine/src/actions.ts:97-127`). |
| `citations.check` | Checks `[n]` citations against source count and that each source is cited; returns broken and unresolved lists and `citation_ok` (`packages/workflow-engine/src/actions.ts:129-141`). |
| `verdict.aggregate` | Uses a fixed read order. Removes dropped findings, settles them, then returns `rework` for any critical, more than five high, or unmet criteria; otherwise `block` for unchecked dimensions, else `pass`. A pass with high findings sets `warn` (`packages/workflow-engine/src/actions.ts:143-167`, `packages/workflow-engine/src/actions.ts:180-181`). |
| `lp.propose_workflow` | Returns empty output and detail containing the proposed workflow and templated inputs; the action itself does not start it (`packages/workflow-engine/src/actions.ts:169-174`). |

Action exceptions propagate to the executor attempt loop. The engine retries the attempt according to node retry settings and fails the step/run after retries are exhausted (`packages/workflow-engine/src/engine.ts:794-831`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Execution Engine](execution-engine.md)
