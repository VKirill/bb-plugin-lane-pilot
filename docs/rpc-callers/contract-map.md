---
title: RPC contract composition and route families
type: component
created: 2026-10-20
updated: 2026-11-26
status: active
confidence: medium
tags: [rpc, contracts, validation]
sources:
  - src/rooms/contracts/index.ts
  - src/rooms/contracts/rpc-shell.ts
  - src/rooms/contracts/rpc-ops.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/settings/server/handlers/rpc/preferences.ts
  - src/rooms/runs/server/handlers/runs-rpc.ts
  - packages/contracts/src/schemas.ts
---

# RPC contract composition and route families

TL;DR: `rpcContract` combines the nine validated route maps (`shell`, `native`, `runs`, `settings`, `ops`, `knowledge`, `workflow`, `workflow-export`, `workflow-map`), while `registerRpc` supplies room-registered handler maps and times each call.

## Purpose

This page explains how the root app RPC contract is assembled and how the shell and operations families describe their requests, results, domain outcomes and handler failures.

## How it works

1. The contracts room imports `rpcShell`, `rpcNative`, `rpcRuns`, `rpcSettings`, `rpcOps`, `rpcKnowledge`, `rpcWorkflow`, `rpcWorkflowExport`, and `rpcWorkflowMap`, spreads them in that order into `defineRpcContract`, and exports the resulting contract (`src/rooms/contracts/index.ts`).
2. Each method schema validates its input before its handler runs. `.strict()` rejects undeclared object fields; defaults fill omitted values; nullable and discriminated unions select declared variants (`src/rooms/contracts/rpc-shell.ts`, `src/rooms/contracts/rpc-ops.ts`).
3. `registerRpc` collects RPC handlers from registered rooms via `src/rooms/registry.ts`, wraps them with `timeRpcHandlers`, then registers the pair with BB (`src/rooms/core/server/rpc.ts`, `src/rooms/core/server/rpc-timing.ts`).

### `rpcShell`

The shell map declares preference, locale, remembered project, section, project, global settings, agent inventory, and agent-profile procedures (`src/rooms/contracts/rpc-shell.ts:41-100`). Handlers live in the settings room (`src/rooms/settings/server/handlers/rpc/preferences.ts`).

1. Locale reads accept a suggested `en|ru` locale. `get_preferences` returns stored preference (`auto|en|ru`), resolved locale and nullable last project; `set_locale` stores the requested preference and returns the resolved locale (`src/rooms/contracts/rpc-shell.ts:42-49`).
2. Project and section reads use strict empty/project-id inputs and return typed lists. `remember_project` accepts a nonempty project id and returns `{ok:true}`.
3. `get_globals` returns parsed defaults, a nonnegative revision, agent profiles and optional hosts/session-policy fields. `save_globals` checks `expectedRevision` and returns `ok:false` on conflict.
4. `get_agent_inventory` accepts nullable project and host ids and returns `ready`, `unavailable`, or `error` status per resource group (`src/rooms/contracts/rpc-shell.ts:85-96`, `packages/contracts/src/schemas.ts`).

| Route branch | Inputs and result | Failure or alternate outcome |
|---|---|---|
| Locale | Requested preference is `auto`, `en` or `ru`; suggested locale is `en` or `ru`. | Invalid enum or extra fields fail schema validation. |
| Inventory | Nullable project and host ids; each group is `ready`, `unavailable` or `error`. | Catalog readiness remains distinct from an empty item list. |
| Global settings | Nonnegative expected revision and strict defaults. | Revision mismatch returns `{ok:false}` with latest snapshot. |
| Agent profile | Bounded prompt/description/lists and expected hash. | Hash, corruption and compilation failures return `{ok:false}`. |

### `rpcOps` run control, statistics and deployment

The operations map defines strict methods for run control, statistics, deploy drain, canary status, memory probe, stack install, deferrals, task return, work graph, money, conveyor, owner waiting, errands, and specialist overview (`src/rooms/contracts/rpc-ops.ts:6-200`).

1. `cancel_attempt` waits a bounded time for the writer to finish stopping and captures its worktree before marking canceled ([rollback](../rollback.md)). `halt_run` marks the run halted, cancels open attempts, and reports `canceled` vs `left` (`src/rooms/contracts/rpc-ops.ts:8-19`).
2. `retry_attempt` creates a new queued attempt if eligible (`ok:false` otherwise). `resume_runs` delegates to orphan recovery for the project (`src/rooms/contracts/rpc-ops.ts:20-31`).
3. `critic_stats`, `writer_reuse_stats`, `acceptance_stats`, and `work_graph_stats` expose execution metrics; `deploy_drain` and `canary_status` expose deploy state (`src/rooms/contracts/rpc-ops.ts:33-70`).

| Family | Contract branches | Result and failure behavior |
|---|---|---|
| Run controls | Nonempty run or attempt id; project id for resume. | Cancellation and retry refusals are `{ok:false}` values; halt reports partial cancellation through `left`. |
| Statistics | Critic/reuse days 1–90 (default 7); acceptance days 1–90 (default 28). | Typed routes validate their output against shared schemas in `@lane-pilot/contracts`. |
| Deploy drain | `deploy_drain` takes `{on: boolean}`; `canary_status` takes `{}`. | Handler returns version and drain/canary state. |

## Business rules

The contract declares accepted shapes and outputs; authorization and domain decisions happen in handlers (`src/rooms/contracts/rpc-ops.ts`, `src/rooms/core/server/rpc.ts`).

## Public API or commands

`rpcContract` is exported from `src/rooms/contracts/index.ts`; root handler registration is described in [RPC and host-call contracts](../rpc-callers.md).

## Gotchas

- Schema validation failure occurs before the method handler; a returned `ok:false` is a domain result and is not an RPC rejection (`src/rooms/contracts/rpc-shell.ts`, `src/rooms/contracts/rpc-ops.ts`).
- Caught failures are route-specific while uncaught rejections pass through `timeRpcHandlers` (`src/rooms/core/server/rpc-timing.ts`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Shared packages](../packages.md)
- [RPC and host-call contracts](../rpc-callers.md)
