---
title: RPC route execution details
type: component
created: 2026-10-14
updated: 2026-11-26
status: active
confidence: high
tags: [rpc, routes, failures]
sources:
  - src/rooms/contracts/rpc-knowledge.ts
  - src/rooms/contracts/rpc-workflow.ts
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/memory/server/handlers/session-memory.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/contracts/index.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/contracts/rpc-ops.ts
  - src/rooms/workflow/server/services/workflow-ops.ts
  - src/rooms/workflow/server/handlers/rpc/workflow-ops.ts
  - src/rooms/workflow/server/handlers/rpc/workflows.ts
  - src/rooms/workflow/server/services/workflow-library.ts
---

# RPC route execution details

TL;DR: The knowledge, workflow, run, and session-memory RPC maps validate typed inputs before handlers return domain results; absence, refusal, and transport failures use separate result shapes.

## Purpose

Explain how the route families described in [RPC and host-call contracts](rpc-callers.md) execute, branch, and report outcomes.

## How it works

### `rpcKnowledge`

1. `rpcKnowledge` defines `get_routing_hint`, memory import (`memory_import`, `memory_import_eval`), session and project memory (`session_memory_*`, `memory_thread_block`, `memory_records_list`, `memory_record_delete`), `docs_overview`, usage (`token_usage`, `lp_attempt_metrics`, `token_usage_sync`), `secret_issuance`, and `workspace_provider_reset` (`src/rooms/contracts/rpc-knowledge.ts:4-167`).
2. Each declared route uses a strict input and output object. Routing hints accept a project id and optional 1–365 day window.
3. Documentation status returns place mode `auto|on|off`, cadence `nightly|weekly|paused`, a nullable verdict, and nullable last-read time (`src/rooms/contracts/rpc-knowledge.ts:77-89`). Token usage accepts `7d|14d|30d|month`; `token_usage_sync` reports `{started:boolean}`.
4. Secret issuance reports names and consumer metadata, never secret values. Worktree-provider reset clears per-host breaker state (`src/rooms/contracts/rpc-knowledge.ts:153-166`).

| Branch | Outcome | Failure or absence |
|---|---|---|
| Routing & memory | Declared collections and records; optional or nullable fields represent missing domain data. | Strict input validation rejects extra keys and values outside declared bounds or enums. |
| Docs & usage | Query and sync results (`{started:false}` when sync is already running or skipped). | Invalid ranges/months fail schema validation. |
| Provider and secret | Issuance metadata or cleared breaker host ids. | No route returns a provider key or secret value; invalid inputs fail schema validation. |

### `rpcWorkflow`

1. `workflow_list` returns summaries, file-load problems and project-read state (`not_requested`, `ok`, `no_machine`, or `unavailable`); `workflow_get` and `workflow_run_snapshot` represent absence with `null` (`src/rooms/contracts/rpc-workflow.ts:6-23`, `src/rooms/workflow/server/services/workflow-library.ts`).
2. `workflow_runs` filters by workflow id, optional project and optional `before` cursor, returns up to 1–50 rows newest-first, and sets `hasMore` (`src/rooms/contracts/rpc-workflow.ts:25-28`, `src/rooms/workflow/server/services/workflow-ops.ts`).
3. `workflow_rerun_node` refuses `lp-task-pipeline` runs; other runs delegate to the engine and return its `ok`, `reason`, `stepKey`, and `removed` count (`src/rooms/contracts/rpc-workflow.ts:30-33`).
4. `workflow_run` starts manual runs (and `liveTrial` runs of `tested` workflows) via `workflowTriggers.start` (`src/rooms/contracts/rpc-workflow.ts:39-45`, `src/rooms/workflow/server/handlers/rpc/workflow-ops.ts`).
5. `workflow_preflight`, `workflow_dry_run`, and `workflow_run_tests` check requirements, run single stubbed trials, or run all declared test cases and persist receipts (`src/rooms/contracts/rpc-workflow.ts:55-71`).
6. Draft and architect routes list/get/create/patch/check/test/publish drafts cleanly with CAS version checks (`src/rooms/contracts/rpc-workflow.ts:73-159`, `src/rooms/workflow/server/handlers/rpc/workflows.ts`).

| Mode or condition | Result | Failure behavior |
|---|---|---|
| Library reads | Missing workflow/snapshot is nullable; failed workflow files are listed as `problems`. | Uncaught read errors reject (`src/rooms/workflow/server/handlers/rpc/workflows.ts`). |
| Run history | Cursor paging queries `limit + 1`, drops the extra row and reports `hasMore`. | Query errors reject the handler. |
| Manual rerun | Internal task-pipeline run refuses; other run/node combinations delegate to the engine. | Engine refusal returns `ok:false,reason`; engine rejection propagates. |
| Live start | Refusals return `ok:false` with structured `reason`/`missing`/`issues`/`envRequests`. | Thrown start failures reject. |
| Preflight, dry run, tests | Missing ids return `found:false`; `green` requires nonempty passing cases. | Store or engine errors propagate. |

### `rpcRuns`

1. `task_board` returns task/workflow rows; `task_card` accepts a task id or null workflow-card id and may return null (`src/rooms/contracts/rpc-runs.ts:47-70`).
2. `task_acceptance_card` returns the acceptance card or null; `list_runs` and stage receipts are paged/loaded per project and section (`src/rooms/contracts/rpc-runs.ts:77-218`).

| Route | Branch and result | Failure or absence |
|---|---|---|
| Task/run/acceptance card | Card returned for known run/task. | Missing records return null (`src/rooms/contracts/rpc-runs.ts`). |
| Run & stage reads | Paging uses nonnegative offset and bounded limits. | Out-of-range inputs fail strict Zod validation. |

### `sessionMemoryRpc`

1. `session_memory_project` resolves the input path to the deepest matching host/docs place (`{projectId:null, scopes:[]}` on error/miss, `src/rooms/memory/server/handlers/session-memory.ts:32-44`).
2. `session_memory_write` checks memory settings, enforces single-claim and parse rules, embeds, stores with `audience: "subagent"` and `trust: "observed"`, triggers conflict detection, and returns inserted/corroborated/duplicate status (`src/rooms/memory/server/handlers/session-memory.ts:58-84`).
3. `session_memory_search` searches active memory (default limit 8, `nothingRelevant:true` when empty), and `session_memory_core` returns unexpired core records plus receipts (`src/rooms/memory/server/handlers/session-memory.ts:85-98`).

## Business rules

All declared method schemas reject extra object keys. Nullable values, booleans, `found` flags, and enums are domain outcomes; they do not hide transport errors (`src/rooms/contracts/rpc-knowledge.ts`, `src/rooms/contracts/rpc-workflow.ts`).

## Public API or commands

The maps are registered through the shared `rpcContract`; route implementation is supplied by room-registered handlers (`src/rooms/contracts/index.ts`, `src/rooms/core/server/rpc.ts`).

## Gotchas

A schema describes accepted payloads and result shapes. It does not implement authorization, persistence policy, or retry behavior; those remain in handlers and services (`src/rooms/memory/server/handlers/session-memory.ts`, `src/rooms/core/server/rpc-timing.ts`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](rpc-callers.md)
