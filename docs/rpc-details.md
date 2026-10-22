---
title: RPC route execution details
type: component
created: 2026-10-14
updated: 2026-10-20
status: active
confidence: high
tags: [rpc, routes, failures]
sources:
  - src/rooms/contracts/rpc-knowledge.ts
  - src/rooms/contracts/rpc-workflow.ts
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/memory/server/session-memory.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/anamnesis/contract.ts
  - src/rooms/contracts/index.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/contracts/rpc-ops.ts
  - src/rooms/workflow/server/workflow-ops.ts
  - src/rooms/workflow/server/rpc/workflow-ops.ts
  - src/rooms/workflow/server/rpc/workflows.ts
  - src/rooms/harness/server/rpc.ts
  - src/rooms/workflow/server/workflow-library.ts
---

# RPC route execution details

TL;DR: The knowledge, workflow, run, and session-memory RPC maps validate typed inputs before handlers return domain results; absence, refusal, and transport failures use separate result shapes.

## Purpose

Explain how the route families described in [RPC and host-call contracts](rpc-callers.md) execute, branch, and report outcomes.

## How it works

### `rpcKnowledge`

1. `rpcKnowledge` builds the knowledge method map. It includes council methods, routing hints, rule proposal reads and writes, memory routes, documentation status, token usage, secret issuance, Jev provider settings, and worktree-provider status; it spreads in `anamnesisRpcMethods` at composition time (`src/rooms/contracts/rpc-knowledge.ts:15-16`, `:17-62`).
2. Each declared route uses a strict input and output object. Council methods use project or council ids, optional council text up to 4,000 characters, and optional decision requests; routing hints accept an optional 1–365 day window (`src/rooms/contracts/rpc-knowledge.ts:17-49`).
3. Rule and memory methods validate proposal actions, audiences, rule length, memory content and concepts, then declare collections, records, nullable values, and booleans as their outputs (`src/rooms/contracts/rpc-knowledge.ts:51-101`, `:116-131`). Session-memory handler behavior is detailed below.
4. Documentation status returns place mode `auto|on|off`, cadence `nightly|weekly|paused`, a nullable verdict, and nullable last-read time (`src/rooms/contracts/rpc-knowledge.ts:103-114`). Token usage accepts `7d|14d|30d|month`; rebuild returns started metadata or `{started:false}` when it does not start (`src/rooms/contracts/rpc-knowledge.ts:133-177`).
5. Secret issuance reports names and consumer metadata, never secret values. Jev status reports chosen/effective provider and key presence; provider test has structured `ok`, latency, and nullable error fields. Worktree-provider methods report or clear per-host breaker state (`src/rooms/contracts/rpc-knowledge.ts:179-210`).

| Branch | Outcome | Failure or absence |
|---|---|---|
| Council, routing, rules, memory, docs | Declared collections and records; optional or nullable fields represent missing domain data. | Strict input validation rejects extra keys and values outside declared bounds or enums. |
| Token usage | Query, sync, and rebuild results; rebuild carries backup and row-clear metadata when it starts. | A concurrent rebuild is represented by `{started:false}`. |
| Provider and secret | Provider identity and key presence, issuance metadata, test result, or breaker state. | No route returns a provider key; invalid provider ids or malformed inputs fail schema validation. |

### Writer harness operations

The harness routes are registered from the harness room. Status and configuration are project-scoped; edit can run in the background unless `wait` is true; tick accepts a dry-run flag; reflection is keyed by harness id. The contract leaves all five outputs unknown, so result shapes are owned by the harness implementation (`src/rooms/contracts/rpc-ops.ts:110-129`, `src/rooms/harness/server/rpc.ts:7-17`, `src/rooms/core/server/rpc.ts:47-49`).

### `rpcWorkflow`

1. `workflow_list` returns summaries, file-load problems and project-read state. Project is `not_requested`, `ok`, `no_machine` or `unavailable`; `workflow_get` and `workflow_run_snapshot` represent absence with `null` (`src/rooms/contracts/rpc-workflow.ts:5-20`, `src/rooms/workflow/server/workflow-library.ts:93-100`, `:150-165`).
2. `workflow_runs` filters by workflow id, optional project and optional `createdAt` cursor, queries one extra row, returns up to the requested 1–50 rows newest-first, and sets `hasMore` from that extra row (`src/rooms/contracts/rpc-workflow.ts:21-28`, `src/rooms/workflow/server/workflow-ops.ts:31-43`).
3. `workflow_rerun_node` refuses `lp-task-pipeline` runs and ids with an `lp-task:` idempotency key as `{ok:false,reason:"pipeline_run"}`. Other runs delegate to the engine and map its success to step key/removed count or its refusal reason (`src/rooms/contracts/rpc-workflow.ts:29-33`, `src/rooms/workflow/server/workflow-ops.ts:46-52`).
4. `workflow_run` sends id, project, inputs, `manual|telegram` source and optional `liveTrial` to `workflowTriggers.start`. A success returns run id, created flag, status and unchecked requirements; a refusal returns reason/message and includes missing inputs, issues or environment requests only when supplied (`src/rooms/contracts/rpc-workflow.ts:34-52`, `src/rooms/workflow/server/rpc/workflow-ops.ts:17-21`).
5. `workflow_preflight` loads the library and returns `found:false` with empty issues/checks for an unknown id. If no preflight checker or project id is available, an existing workflow returns `found:true, ok:true` with empty checks; otherwise the checker result is returned (`src/rooms/contracts/rpc-workflow.ts:47-52`, `src/rooms/workflow/server/workflow-ops.ts:54-60`).
6. Dry run takes the first declared test case, overlays caller input on that case, runs it with external actions stubbed and returns the trial plus stub list. Missing workflow returns `found:false, result:null, stubbed:[]` (`src/rooms/contracts/rpc-workflow.ts:54-62`, `src/rooms/workflow/server/workflow-ops.ts:62-71`).
7. Test execution runs every workflow case against stubs. Missing workflow returns false/empty/null; otherwise green requires at least one case and every case to pass, then the handler records the receipt, invalidates catalog state, schedules project trigger sync and reloads current status (`src/rooms/contracts/rpc-workflow.ts:59-64`, `src/rooms/workflow/server/workflow-ops.ts:73-89`).
8. Draft creation loads the source workflow. `edit` refuses built-ins and reuses an existing same-scope draft; `duplicate` chooses an unused copy id and uses requested scope or global. Missing source returns `not_found` (`src/rooms/contracts/rpc-workflow.ts:95-100`, `src/rooms/workflow/server/rpc/workflows.ts:21-41`).

| Mode or condition | Result | Failure behavior |
|---|---|---|
| Library reads | Missing workflow/snapshot is nullable; failed workflow files are listed as `problems` and project machine state remains explicit (`src/rooms/contracts/rpc-workflow.ts:5-20`). | Library loading/DB/SDK errors not converted by the read handler reject (`src/rooms/workflow/server/rpc/workflows.ts:10-17`). |
| Run history | Cursor paging queries `limit + 1`, drops the extra row and reports `hasMore` (`src/rooms/contracts/rpc-workflow.ts:21-28`, `src/rooms/workflow/server/workflow-ops.ts:31-43`). | Query errors reject the handler. |
| Manual rerun | Internal task-pipeline run refuses; other run/node combinations delegate to the engine (`src/rooms/workflow/server/workflow-ops.ts:46-52`). | Engine refusal returns `ok:false,reason`; engine rejection propagates. |
| Live start | Accepted start and product refusal are both typed values; Telegram source is a contract mode and trigger eligibility is decided by the start service (`src/rooms/contracts/rpc-workflow.ts:34-45`, `src/rooms/workflow/server/rpc/workflow-ops.ts:17-21`). | Thrown start failures reject; declared `ok:false` refusals are returned. |
| Preflight, dry run, tests | Missing ids return `found:false`; absent preflight context treats an existing item as clear; test `green` requires nonempty all-green cases (`src/rooms/workflow/server/workflow-ops.ts:54-89`). | Library, test runner, receipt write or reload failures propagate. |
| Draft source | Edit built-in -> `builtin_read_only`; edit existing draft -> reused; duplicate -> fresh unique id (`src/rooms/workflow/server/rpc/workflows.ts:21-41`). | Missing source is a `not_found` value; later draft creation failures reject. |

| Mode | Output and branch | Failure representation |
|---|---|---|
| Live start | Manual or Telegram source; result includes started run fields when accepted. | Preflight issues and start refusal use declared reason/missing-input/requirement fields. |
| Dry run and test | Dry run returns one nullable result and stubbed actions; tests return all case results plus `green` and status. | Trial failures remain case results; invalid payloads fail schema validation (`src/rooms/contracts/rpc-workflow.ts:54-62`). |
| Draft | Create selects `edit` or `duplicate`; patch and restore optionally guard by expected version. | Version and business conflicts are represented by each operation's declared result; handler rejection propagates. |
| Architect | Returns thread and project identifiers and whether a living thread was reused. | The schema does not turn handler or transport rejection into a successful result. |

### `rpcRuns`

1. `task_board` returns task/workflow rows; `task_card` accepts a task id or null workflow-card id and may return null (`src/rooms/contracts/rpc-runs.ts:30-57`).
2. Run-card lookup can be nullable. Stage listing returns summaries, while `get_stage_result` returns `found` and a nullable result (`src/rooms/contracts/rpc-runs.ts:64-102`).
3. `list_runs` requires project id, optional section, nonnegative integer offset, and integer limit 1–200; optional `pinOpen` controls open-run pinning (`src/rooms/contracts/rpc-runs.ts:91-94`).
4. `get_screen` takes project, optional section, and optional run limit 1–200. It includes screen settings and recent runs, an optional writer binding with five resolution states, and a nullable writer trace (`src/rooms/contracts/rpc-runs.ts:125-144`, `:153-190`).

| Route | Branch and result | Failure or absence |
|---|---|---|
| Task/run card | Card may be returned for a known run/task. | `task_card` and run-card lookup can return null when the record is absent (`src/rooms/contracts/rpc-runs.ts:44-70`). |
| Stage result | Separately fetched result body and `found` flag. | Missing result uses `found:false` and `result:null`; invalid ids fail validation (`src/rooms/contracts/rpc-runs.ts:95-102`). |
| Run paging | Required offset and 1–200 limit. | Negative offset, non-integer values, or out-of-range limit fail schema validation (`src/rooms/contracts/rpc-runs.ts:91-94`). |
| Screen binding | `resolved`, `ambiguous`, `setup_required`, `offline`, or `catalog_unavailable`. | These are domain binding states; nullable host/path fields carry unresolved states (`src/rooms/contracts/rpc-runs.ts:125-144`). |

### `sessionMemoryRpc`

1. `session_memory_project` resolves the input path, reads projects and docs places, and selects the deepest matching place on the requested host. Project-list or docs-place errors are caught as empty results; no match returns `projectId:null` and empty scopes (`src/rooms/memory/server/session-memory.ts:18-30`).
2. `session_memory_write` checks project memory settings. Disabled memory returns `memory_disabled`; otherwise it parses one candidate with enlarged parse budgets, stores it as observed session-origin memory for `subagent`, and returns inserted id or `corroborated`/`duplicate` status (`src/rooms/memory/server/session-memory.ts:32-45`).
3. Candidate parsing and storage are separately caught and returned as `stored:false` with a reason. Search uses configured engine and audience, defaults limit to 8, includes observed records, and maps results to id/kind/content/concepts (`src/rooms/memory/server/session-memory.ts:35-53`).
4. Core read selects active, unexpired core records for the `subagent` audience in creation order. Lesson submission upserts a proposal, adopts it only when newly created, then returns proposal id, repeat id, state, and adoption result (`src/rooms/memory/server/session-memory.ts:55-66`).

| Branch | Inputs and outputs | Failure behavior |
|---|---|---|
| Path lookup | Host and absolute path; returns deepest project/scopes match or null/empty. | Project and docs-place lookup errors become no match. |
| Write | `core` or `note`; content 1–8,000 chars, up to 24 concepts. | Disabled, parse error, storage error, corroborated, and duplicate outcomes are returned as values. |
| Search/core | Search query with optional limit 1–50; core read takes project id. | Database/search failures are not caught by these handlers and reject the call. |
| Lesson | Rule, optional evidence/scope/audience/always; new proposal may be adopted. | Upsert/adoption failures propagate as handler rejections. |

## Business rules

All declared method schemas reject extra object keys. Nullable values, booleans, `found` flags, and enums are domain outcomes; they do not hide transport errors (`src/rooms/contracts/rpc-knowledge.ts:17-60`, `:63-210`, `src/rooms/contracts/rpc-workflow.ts:5-130`).

## Public API or commands

The maps are registered through the shared `rpcContract`; route implementation is supplied by domain handler factories (`src/rooms/contracts/index.ts:18-27`, `src/rooms/core/server/rpc.ts:28-52`).

## Gotchas

A schema describes accepted payloads and result shapes. It does not implement authorization, persistence policy, or retry behavior; those remain in the handler and called services (`src/rooms/memory/server/session-memory.ts:32-67`, `src/rooms/core/server/rpc-timing.ts:12-40`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](rpc-callers.md)
