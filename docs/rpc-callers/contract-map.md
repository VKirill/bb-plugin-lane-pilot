---
title: RPC contract composition and route families
type: component
created: 2026-10-20
updated: 2026-10-20
status: active
confidence: medium
tags: [rpc, contracts, validation]
sources:
  - src/rooms/contracts/index.ts
  - src/rooms/contracts/rpc-shell.ts
  - src/rooms/contracts/rpc-ops.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/settings/server/rpc/preferences.ts
  - src/rooms/runs/server/rpc/runs.ts
  - src/rooms/self-repair/server/self-repair.ts
  - packages/contracts/src/schemas.ts
---

# RPC contract composition and route families

TL;DR: `rpcContract` combines eight validated method maps, while `registerRpc` supplies matching handler maps and times each call.

## Purpose

This page explains how the root app RPC contract is assembled and how the shell and operations families describe their requests, results, domain outcomes and handler failures.

## How it works

1. The contracts room imports shell, native, runs, settings, operations, knowledge, workflow and world maps, spreads them in that order into `defineRpcContract`, and exports the resulting contract (`src/rooms/contracts/index.ts:1-27`). The maps are included unconditionally; route-level optional values and enums are the only branch points declared here.
2. Each method schema validates its input before its handler runs. `.strict()` rejects undeclared object fields; defaults fill omitted values; nullable and discriminated unions select declared variants (`src/rooms/contracts/rpc-shell.ts:8-18`, `src/rooms/contracts/rpc-ops.ts:5-64`).
3. `registerRpc` constructs handler maps using room dependencies, spreads them into one object, wraps the handlers with `timeRpcHandlers`, then registers the pair with BB (`src/rooms/core/server/rpc.ts:28-52`). The timing wrapper returns handler results unchanged and rethrows handler rejection; timing and answer-size logging errors are contained (`src/rooms/core/server/rpc-timing.ts:12-40`).

### `rpcShell`

The shell map first spreads `scheduleRpcContract`, then declares preference, project, section, global settings, inventory and agent-profile procedures (`src/rooms/contracts/rpc-shell.ts:1-8`, `:12-109`). `rpcShell` itself does not call a service: its schemas bound inputs and outputs, and the settings-room handlers implement the operations.

1. Locale reads accept a suggested `en|ru` locale. `get_preferences` returns the stored preference (`auto|en|ru`), its resolved locale and the nullable last project; `set_locale` stores the requested preference and returns the resolved locale (`src/rooms/contracts/rpc-shell.ts:8-18`). The handler maps unknown stored preferences to `auto`, and resolves `auto` from the suggestion (`src/rooms/settings/server/rpc/preferences.ts:15-29`).
2. Project and section reads use strict empty/project-id inputs and return typed lists. `remember_project` accepts a nonempty project id and returns literal `{ok:true}` when its handler resolves (`src/rooms/contracts/rpc-shell.ts:19-32`).
3. `get_globals` returns parsed defaults, a nonnegative revision, agent profiles and optional hosts/session-policy fields. `save_globals` requires a matching expected revision; the handler returns `ok:false` with the current snapshot on conflict, otherwise saves parsed defaults and returns the next revision (`src/rooms/contracts/rpc-shell.ts:33-60`, `:74-89`, `src/rooms/settings/server/rpc/preferences.ts:106-116`). Host listing errors during global reads are caught by the handler and yield an empty host list (`src/rooms/settings/server/rpc/preferences.ts:35-64`).
4. `get_agent_inventory` requires nullable project and host ids; each of four resource groups carries the shared ready/unavailable/error result shape (`src/rooms/contracts/rpc-shell.ts:62-72`, `packages/contracts/src/schemas.ts:152-156`). The handler resolves omitted targets through remembered/visible projects and connected/first hosts, then queries only catalogs whose target ids resolve (`src/rooms/settings/server/rpc/preferences.ts:66-104`).
5. `save_agent_profile` validates an id, prompt, optional description and lists, optional per-resource `inherit|none|selected` modes, and an expected source hash. The handler returns `ok:false` for stale hash, corrupt source or compile errors; success stores the override and returns its hash (`src/rooms/contracts/rpc-shell.ts:91-109`, `src/rooms/settings/server/rpc/preferences.ts:117-145`).

| Route branch | Inputs and result | Failure or alternate outcome |
|---|---|---|
| Locale | Requested preference is `auto`, `en` or `ru`; suggested locale is `en` or `ru`. | Invalid enum or extra fields fail schema validation; unknown stored locale is normalized to `auto` (`src/rooms/contracts/rpc-shell.ts:8-18`, `src/rooms/settings/server/rpc/preferences.ts:15-29`). |
| Inventory | Nullable project and host ids; each group is `ready`, `unavailable` or `error`. | Catalog readiness remains distinct from an empty item list (`src/rooms/contracts/rpc-shell.ts:62-72`, `packages/contracts/src/schemas.ts:152-156`). |
| Global settings | Nonnegative expected revision and strict defaults. | Revision mismatch is a normal `{ok:false}` result with the latest snapshot; host-list read errors are caught as `hosts: []` (`src/rooms/settings/server/rpc/preferences.ts:35-64`, `:106-116`). |
| Agent profile | Prompt 1–32,000 chars; description up to 400; each resource list up to 64; expected hash is empty or 64 lowercase hex characters. | Hash, corruption and compilation failures return `{ok:false}`; validation errors and uncaught storage errors reject (`src/rooms/contracts/rpc-shell.ts:91-109`, `src/rooms/settings/server/rpc/preferences.ts:117-145`). |
| Project and section reads | Empty object for project list; nonempty project id for section list. | Handler-side list errors reject the call (`src/rooms/contracts/rpc-shell.ts:19-32`). |

### `rpcOps` run control, statistics and deployment

The operations map defines strict methods for run control, statistics and deployment drain in its first 64 lines. Run controls return declared state/refusal values; statistics return either a typed result or `unknown`; deploy methods deliberately leave output shape to the stability handler (`src/rooms/contracts/rpc-ops.ts:5-64`).

1. `cancel_attempt` delegates to the attempt cancellation handler. `halt_run` first marks the run halted, lists open attempts, tries cancellation for each, collects successful ids in `canceled` and failures in `left`, removes the run from parked work when KV contains an array, and reports `ok` only when `left` is empty (`src/rooms/runs/server/rpc/runs.ts:304-316`).
2. `retry_attempt` returns `ok:false` for a missing attempt, a state outside the retry-eligible set, or exhausted attempt limit. Exhaustion transitions the existing attempt to `blocked`; an eligible retry creates a new queued attempt and returns its id (`src/rooms/runs/server/rpc/runs.ts:317-332`). `resume_runs` delegates to orphan recovery for the project and returns its resumed, skipped and finished ids (`src/rooms/runs/server/rpc/runs.ts:333-334`).
3. `writer_brief_stats` uses the required `since` and optional `until`, defaulting the end to current time. Critic and reuse stats convert the validated days window into a timestamp; acceptance statistics use their typed contract schema (`src/rooms/contracts/rpc-ops.ts:27-55`, `src/rooms/self-repair/server/self-repair.ts:829-837`).
4. `deploy_drain` passes `on` to the core drain and returns its state with the running version; `deploy_status` returns the same version plus current drain status (`src/rooms/self-repair/server/self-repair.ts:831-832`). The methods return domain refusals and results as values; exceptions not caught inside their handler reject through the timing wrapper (`src/rooms/core/server/rpc-timing.ts:12-40`).

| Family | Contract branches | Result and failure behavior |
|---|---|---|
| Run controls | Nonempty run or attempt id; project id for resume. | Cancellation and retry refusals are `{ok:false}` values; halt reports partial cancellation through `left`; handler/service errors can reject (`src/rooms/contracts/rpc-ops.ts:6-25`, `src/rooms/runs/server/rpc/runs.ts:304-334`). |
| Statistics | Writer brief has integer time bounds; critic/reuse days are 1–90, default 7; acceptance days are 1–90, default 28 and project is optional. | Typed routes validate their output; writer brief is `unknown` at this contract, leaving shape validation to its caller (`src/rooms/contracts/rpc-ops.ts:27-55`). |
| Deploy drain | `deploy_drain` takes a boolean; `deploy_status` takes `{}`. | Handler returns version and drain snapshot; uncaught failures reject (`src/rooms/contracts/rpc-ops.ts:56-64`, `src/rooms/self-repair/server/self-repair.ts:831-832`). |

## Business rules

The contract declares accepted shapes and outputs; authorization and domain decisions happen in handlers. An `unknown` output schema means the contract does not validate the implementation's result structure (`src/rooms/contracts/rpc-ops.ts:27-64`, `src/rooms/core/server/rpc.ts:28-52`).

## Public API or commands

`rpcContract` is exported from `src/rooms/contracts/index.ts`; root handler registration is described in [RPC and host-call contracts](../rpc-callers.md) (`src/rooms/contracts/index.ts:15-27`).

## Gotchas

- Schema validation failure occurs before the method handler; a returned `ok:false` is a domain result and is not an RPC rejection (`src/rooms/contracts/rpc-shell.ts:74-109`, `src/rooms/contracts/rpc-ops.ts:6-25`).
- A caught failure is route-specific: global host inventory read becomes an empty list, while handler rejections pass through timing (`src/rooms/settings/server/rpc/preferences.ts:35-64`, `src/rooms/core/server/rpc-timing.ts:12-40`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Shared packages](../packages.md)
- [RPC and host-call contracts](../rpc-callers.md)
