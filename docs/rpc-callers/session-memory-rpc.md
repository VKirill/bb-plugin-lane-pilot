---
title: Session memory RPC
type: component
created: 2026-10-16
updated: 2026-10-28
status: active
confidence: medium
tags: [rpc, memory, sessions]
sources:
  - src/rooms/memory/server/handlers/session-memory.ts
  - src/rooms/contracts/rpc-knowledge.ts
  - src/rooms/core/server/rpc.ts
  - packages/memory-core/src/candidates.ts
  - packages/memory-core/src/store.ts
  - src/rooms/contracts/index.ts
  - src/rooms/core/server/rpc-timing.ts
---

# Session memory RPC

TL;DR: Session memory RPC resolves a workspace to its project, imports and stores subagent-audience observations, searches active memory, lists core records, and manages memory records.

## Purpose

`sessionMemoryRpc` gives sessions on a machine access to the project memory stored by the plugin server (`src/rooms/contracts/rpc-knowledge.ts:15-76`, `src/rooms/memory/server/handlers/session-memory.ts`).

## `rpcKnowledge` contract map

`rpcKnowledge` is a strict method map spread into the app-facing `rpcContract`; methods validate request and response shapes, while handlers own storage, authorization and domain behavior (`src/rooms/contracts/rpc-knowledge.ts:4-167`, `src/rooms/contracts/index.ts`).

| Procedure family | Inputs, branches and outcomes |
|---|---|
| Routing hint | Project id and optional 1–365 day window; returns nullable current provider/model, hints and stats (`src/rooms/contracts/rpc-knowledge.ts:5-12`). |
| Session & project memory | `memory_import`, `memory_import_eval`, `session_memory_project`, `session_memory_write`, `session_memory_search`, `session_memory_core`, `memory_thread_block`, `memory_records_list`, `memory_record_delete` (`src/rooms/contracts/rpc-knowledge.ts:15-76`). |
| Docs, usage & security | `docs_overview`, `token_usage`, `lp_attempt_metrics`, `token_usage_sync`, `secret_issuance`, `workspace_provider_reset` (`src/rooms/contracts/rpc-knowledge.ts:77-166`). |

| Session-memory route | Contract branch and declared outcome |
|---|---|
| `session_memory_project` | Requires host id and absolute path; returns nullable project id and matching scopes (`src/rooms/contracts/rpc-knowledge.ts:21-24`). |
| `session_memory_write` | Requires project, `core|note`, content 1–8,000 chars, up to 24 concepts, optional `source` and `chain`; returns `stored`, nullable `id` and `reason` (`src/rooms/contracts/rpc-knowledge.ts:25-30`). |
| `session_memory_search` | Requires project and query 1–2,000 chars; optional limit 1–50 and `chain`; returns `records` plus optional `nothingRelevant`/`weakMatch`/`message` (`src/rooms/contracts/rpc-knowledge.ts:31-38`). |
| `session_memory_core` | Requires project id and optional `chain`; returns core record ids/content plus optional receipts (`src/rooms/contracts/rpc-knowledge.ts:39-49`). |
| `memory_records_list` / `memory_record_delete` | Lists project records with provenance (`origin`, `scope`, `sources`, `noTrace`) and erases a record (`src/rooms/contracts/rpc-knowledge.ts:55-76`). |

## How it works

1. `session_memory_project` resolves the requested path against project docs places for the host and returns the deepest match or `{projectId:null, scopes:[]}` (`src/rooms/memory/server/handlers/session-memory.ts:32-44`).
2. `session_memory_write` checks memory settings, enforces single-claim and candidate parsing rules, embeds content, stores with `audience: "subagent"`, `trust: "observed"`, `origin: "session"`, and runs conflict detection (`src/rooms/memory/server/handlers/session-memory.ts:58-84`).
3. `session_memory_search` queries active memory (omitted limit defaults to 8), returning `nothingRelevant: true` when empty (`src/rooms/memory/server/handlers/session-memory.ts:85-92`).
4. `session_memory_core` returns active, unexpired core records in creation order together with memory receipts (`src/rooms/memory/server/handlers/session-memory.ts:94-98`).

## Business rules

Writes use `subagent` audience regardless of caller identity; observed session notes remain quarantined from writers until corroborated or aged 24 hours (`src/rooms/memory/server/handlers/session-memory.ts:75-77`). Core listing filters expired records at read time.

## Public API or commands

Core procedures: `session_memory_project`, `session_memory_write`, `session_memory_search`, `session_memory_core`, `memory_import`, `memory_records_list`, `memory_record_delete`, and `memory_thread_block` (`src/rooms/contracts/rpc-knowledge.ts:15-76`).

## Gotchas

- Writes parse candidates with permissive temporary budgets so `storeMemoryRecordsKeepingOverflow` enforces retained budgets (`src/rooms/memory/server/handlers/session-memory.ts:62-77`, `packages/memory-core/src/store.ts`).
- Only `session_memory_project` catches lookup errors; search and core-list database errors propagate through `timeRpcHandlers`.

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
