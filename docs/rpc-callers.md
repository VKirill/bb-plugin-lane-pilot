---
title: RPC and host-call contracts
type: component
created: 2026-09-30
updated: 2026-11-26
status: active
confidence: medium
tags: [rpc, contracts, host-api]
sources:
  - server.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/contracts/index.ts
  - src/rooms/contracts/host.ts
  - src/rooms/contracts/rpc-shell.ts
  - src/rooms/settings/server/handlers/rpc/preferences.ts
  - src/rooms/native-agent/models/agent-inventory.ts
  - src/rooms/relay/models/owner-locale.ts
  - src/rooms/workflow/server/services/workflow-executors.ts
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/contracts/rpc-native.ts
  - src/rooms/runs/server/handlers/runs-rpc.ts
  - src/rooms/runs/server/services/run-finish.ts
  - src/rooms/native-agent/server/services/native-profile.ts
  - src/rooms/runs/server/services/task-board.ts
  - src/rooms/runs/server/services/task-graph.ts
  - src/rooms/contracts/rpc-knowledge.ts
  - src/rooms/contracts/rpc-workflow.ts
  - src/rooms/contracts/rpc-ops.ts
  - src/rooms/memory/server/handlers/session-memory.ts
  - packages/host-calls/src/run-on-host.ts
  - packages/handoff/src/messages.ts
  - scripts/record_and_guard.py
  - src/rooms/core/server/core.ts
  - src/rooms/memory/server/services/memory.ts
  - host.ts
  - packages/contracts/src/schemas.ts
  - packages/memory-core/src/store.ts
---

# RPC and host-call contracts

TL;DR: The contracts room assembles strict UI RPC schemas and a separate host contract; the core registers one implementation object from domain handlers.

## Purpose

Keep BB app-to-server calls and plugin-server-to-host calls typed independently. The app RPC contract is assembled from shell, native, runs, settings, operations, knowledge, and workflow contracts (`src/rooms/contracts/index.ts`).

## How it works

1. `rpcContract` imports the shell, native, runs, settings, operations, knowledge, workflow, workflow-export, and workflow-map maps, spreads them into one `defineRpcContract` call, and exports that value as the room's public RPC contract (`src/rooms/contracts/index.ts`). Composition is unconditional; optional inputs, enums, bounds, and nullable results are declared on each method (`src/rooms/contracts/rpc-shell.ts`, `src/rooms/contracts/rpc-runs.ts`).
2. `registerRpc` collects room-registered RPC handler maps via the room registry (`src/rooms/core/server/rpc.ts`, `src/rooms/registry.ts`), wraps every handler with `timeRpcHandlers`, and calls `ctx.bb.rpc.register(rpcContract, ...)` once.
3. The timing wrapper awaits each handler and returns its answer unchanged. Rejections are rethrown; `finally` logs elapsed time and distinguishes a refused error from other failures. For successful calls lasting at least 250 ms it logs serialized answer size on a best-effort basis (`src/rooms/core/server/rpc-timing.ts`).

### Route-family behavior

- [RPC contract composition and route families](rpc-callers/contract-map.md) explains `rpcShell` and `rpcOps` validation, handler branches and failure results (`src/rooms/contracts/rpc-shell.ts`, `src/rooms/contracts/rpc-ops.ts`).
- [Run RPC contract](rpc-callers/rpc-runs.md) describes `rpcRuns` request validation, handler steps, missing-record outcomes and failures (`src/rooms/contracts/rpc-runs.ts`).
- `rpcKnowledge` covers routing hints, memory import/session memory/records, docs overview, token usage, attempt metrics, secret issuance, and workspace provider reset; see [Session memory RPC](rpc-callers/session-memory-rpc.md) and [RPC route details](rpc-details.md) (`src/rooms/contracts/rpc-knowledge.ts:4-167`).
- [Workflow RPC contract](rpc-callers/rpc-workflow.md) describes workflow routes; [RPC route details](rpc-details.md) records contract execution modes and result branches (`src/rooms/contracts/rpc-workflow.ts`).
- [Native session and activation RPC](rpc-callers/native-session-rpc.md) explains `rpcNative`, `storeNativeSelection`, their branches and failures (`src/rooms/contracts/rpc-native.ts`, `src/rooms/native-agent/server/services/native-profile.ts`). The Tasks board and acceptance card are described in [Tasks board](task-board.md).
- [Server core construction](rpc-callers/create-core.md) owns the construction sequence and host/credential execution modes for `createCore` (`src/rooms/core/server/core.ts`).

### `rpcKnowledge` contract flow

1. `rpcKnowledge` declares routing hints, memory import and session-memory procedures (`session_memory_project`, `session_memory_write`, `session_memory_search`, `session_memory_core`, `memory_thread_block`, `memory_records_list`, `memory_record_delete`), `docs_overview`, token usage and `lp_attempt_metrics`, `secret_issuance`, and `workspace_provider_reset` (`src/rooms/contracts/rpc-knowledge.ts:4-167`).
2. Each route uses a strict input schema; outputs are structured schemas or `z.unknown()` for handler-defined shapes.
3. Handlers are assembled via registered memory, usage, docs, secrets, and worktree rooms (`src/rooms/registry.ts`, `src/rooms/core/server/rpc.ts`).
4. Contract validation rejects malformed payloads before handlers run; valid calls return route-specific empty, nullable, or status results, and handler throws propagate through `timeRpcHandlers`.

| Route group | Branches and outputs | Failure behavior |
|---|---|---|
| Routing hints | Current provider/model, hints and stats over 1–365 days (`src/rooms/contracts/rpc-knowledge.ts:5-12`). | Invalid project id or day window fails strict schema validation. |
| Session & project memory | Import, project lookup, bounded writes/search, core/list reads, thread block and record deletion (`src/rooms/contracts/rpc-knowledge.ts:15-76`). | Storage/handler failures reject; route-specific `stored:false` or `deleted:false` flags come from handlers. |
| Docs and usage | Docs overview/recheck, token usage range/month/project filters, attempt metrics and usage sync (`src/rooms/contracts/rpc-knowledge.ts:77-151`). | Invalid ranges/dates reject validation; sync returns `started:false` when skipped. |
| Provider/security | Secret issuance journal, workspace provider breaker reset (`src/rooms/contracts/rpc-knowledge.ts:153-166`). | Key material is never returned in route output; cleared host ids report breaker resets. |

### `rpcShell` contract flow

1. The map declares preferences, locale, remembered project, sections, projects, globals, inventory, and agent-profile save/delete/custom-create methods; each route's input object is strict (`src/rooms/contracts/rpc-shell.ts:41-100`).
2. `get_preferences` normalizes unknown saved locale values to `auto`, resolves with the UI's suggested locale, and returns last project or null. `set_locale` stores `auto|en|ru` and returns the resolved `en|ru` value (`src/rooms/contracts/rpc-shell.ts:42-49`, `src/rooms/settings/server/handlers/rpc/preferences.ts`). Workflow human-step detail strings use explicit `en|ru` preference first, then resolved locale (`src/rooms/relay/models/owner-locale.ts`, `src/rooms/workflow/server/services/workflow-executors.ts`).
3. Project and section reads return lists; global reads parse stored defaults and revision, list profiles, and attach host data; host-list failure becomes an empty host list (`src/rooms/settings/server/handlers/rpc/preferences.ts`).
4. `get_agent_inventory` uses explicit project/host ids when given, or falls back to remembered/first visible project and connected/first host. Inventory groups preserve `ready`, `unavailable`, or `error` status (`src/rooms/contracts/rpc-shell.ts:85-96`, `src/rooms/native-agent/models/agent-inventory.ts`).
5. `save_globals` compares `expectedRevision`; mismatch returns `ok:false` with current revision/defaults, while match increments revision.
6. `save_agent_profile` checks the source hash, compiles the profile, and stores the override (`ok:false` on mismatch/corrupt/compile error).

| Route branch | Inputs and limits | Result or failure |
|---|---|---|
| Locale | Preference `auto|en|ru`; suggested locale `en|ru`. | Returns resolved locale and preference; extra fields fail strict validation. |
| Inventory | Nullable project/host ids; resource groups return `ready`, `unavailable`, or `error`. | Unavailable catalogs stay distinct from empty lists. |
| Global defaults | Strict defaults object plus nonnegative `expectedRevision`. | Revision conflict returns `ok:false` with the current snapshot. |
| Agent profile | Id, prompt, description, tools/skills/MCP lists, expected source hash. | Hash/corrupt/compile failures return `ok:false`; success returns source hash. |

### `rpcOps` handlers

1. `rpcOps` declares run control (`halt_run`, `cancel_attempt`, `retry_attempt`, `resume_runs`), statistics (`critic_stats`, `writer_reuse_stats`, `acceptance_stats`, `work_graph_stats`), `deploy_drain`, `canary_status`, `memory_probe`, `stack_*`, `deferral_*`, `task_diff`, `task_return_stage`, `work_graph_*`, `task_draft_*`, `conveyor`, `money_status`, `ui_version`, `first_run_*`, `task_word`, `owner_waiting*`, `errands_*`, and `specialist_overview` (`src/rooms/contracts/rpc-ops.ts:6-200`).
2. Complex room-owned outputs use `z.unknown()` where schema details stay inside the owning room; strict inputs reject malformed payloads before handlers run.

### Memory routes and accepted-task maintenance

`createMemoryStage` runs maintenance after an accepted task or when called explicitly (`src/rooms/memory/server/services/memory.ts`). It checks PM ownership, project/task match, and a passed acceptance receipt before inspecting memory settings. Existing terminal receipts return unchanged; disabled memory/maintenance records `skipped` unless a child already exists. When active, it parses candidates, applies budgets via `storeMemoryRecordsKeepingOverflow` (`packages/memory-core/src/store.ts`), and records the stage receipt idempotently.

## Public API or commands

`rpcContract` is assembled in the contracts room and re-exported by `server.ts` (`src/rooms/contracts/index.ts`, `server.ts`). See [Host RPC contract](rpc-callers/host-contract.md) for `hostContract` registration and execution, [Server core construction](rpc-callers/create-core.md) for `createCore`, and [Handoff message](rpc-callers/handoff-message.md) for handoff formatting.

`main` in `scripts/record_and_guard.py` requires a log path and guard path (else exit 2), logs parsed JSONL payload lines, adds `agent_type: lane-pilot-pm` only when missing on mapping input with `LANE_PILOT_PM=1`, and runs the guard subprocess with `AGENT_HOOK_CLIENT=claude`.

## Gotchas

The RPC contract is a shape contract; authorization and ownership checks remain in handlers. For example, memory maintenance checks PM role, run id, project, task and acceptance receipt before starting (`src/rooms/memory/server/services/memory.ts`). Host ids appear in both `runOnHost`'s request and call options because the BB client contract needs both (`packages/host-calls/src/run-on-host.ts:1-5`, `:26-31`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot architecture](architecture.md)
- [Protecting Lane Pilot database access](decisions/2026-10-08-lane-pilot-data-db-access.md)
- [Lane Pilot overview](overview.md)
- [Shared packages](packages.md)
- [RPC contract composition and route families](rpc-callers/contract-map.md)
- [Server core construction](rpc-callers/create-core.md)
- [Handoff message](rpc-callers/handoff-message.md)
- [Host RPC contract](rpc-callers/host-contract.md)
- [Native session and activation RPC](rpc-callers/native-session-rpc.md)
- [Run RPC contract](rpc-callers/rpc-runs.md)
- [Workflow RPC contract](rpc-callers/rpc-workflow.md)
- [Session memory RPC](rpc-callers/session-memory-rpc.md)
- [RPC route execution details](rpc-details.md)
