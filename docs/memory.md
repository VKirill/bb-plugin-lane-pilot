---
title: Project memory
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [memory, knowledge, maintenance]
sources:
  - src/rooms/memory/server/memory.ts
  - src/rooms/memory/server/session-memory.ts
  - src/rooms/memory/ui/memory-records.tsx
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/lifecycle.ts
  - packages/memory-core/src/context.ts
  - src/rooms/storage/database.ts
  - src/rooms/contracts/rpc-knowledge.ts
---

# Project memory

TL;DR: Project memory stores scoped records in plugin SQLite, exposes search and maintenance through RPC and PM tools, and records maintenance as a writer-stage receipt.

## Purpose

Keep project facts and rules available to PM, writer, and terminal sessions through a shared hub-side memory store (`src/rooms/memory/server/session-memory.ts:11-15`, `src/rooms/storage/database.ts:157-168`).

## How it works

1. `session_memory_project` maps a host path to the deepest matching project scope (`src/rooms/memory/server/session-memory.ts:18-30`).
2. `session_memory_write` validates a candidate, stores it for the `subagent` audience as `observed`, and returns an inserted, corroborated, duplicate, disabled, or validation result (`src/rooms/memory/server/session-memory.ts:32-48`).
3. `session_memory_search` retrieves subagent-visible records; `session_memory_core` returns active core records whose expiry is unset or in the future (`src/rooms/memory/server/session-memory.ts:50-59`).
4. `createMemoryStage` runs after acceptance and validates PM/run/task ownership and requires a passed acceptance receipt before starting maintenance (`src/rooms/memory/server/memory.ts:22-47`).
5. The maintenance stage creates or resumes one `memory-maintenance` stage receipt and skips work when memory is disabled or maintenance is off (`src/rooms/memory/server/memory.ts:58-83`).
6. `MemoryRecords` lists records, separates rules from facts, and permits deleting facts; rule rows do not expose a delete action (`src/rooms/memory/ui/memory-records.tsx:18-36`, `:38-63`).

## Modes and states

| Mode or state | Behavior | Evidence |
|---|---|---|
| Memory disabled | A session write returns `memory_disabled`; maintenance records a skipped stage (`src/rooms/memory/server/session-memory.ts:32-35`, `src/rooms/memory/server/memory.ts:65-70`). |
| Observed session record | Stored for `subagent`, with `trust: observed` and `origin: session` (`src/rooms/memory/server/session-memory.ts:38-45`). |
| Accepted task | Memory maintenance can run only after the writer acceptance receipt passed (`src/rooms/memory/server/memory.ts:43-47`). |
| Existing terminal maintenance receipt | Reuse the prior result; another maintenance pass requires a new task (`src/rooms/memory/server/memory.ts:61-64`). |
| Rule record | Displayed separately and cannot be deleted through the facts action (`src/rooms/memory/ui/memory-records.tsx:36-46`). |

## Business rules

Memory writes are scoped by project, personal bot, audience, source hash, and parsed memory settings (`src/rooms/memory/server/session-memory.ts:32-45`). Core records returned to sessions must be active and unexpired (`src/rooms/memory/server/session-memory.ts:55-58`).

## Public API or commands

`sessionMemoryRpc` implements the session RPC methods: `session_memory_project`, `session_memory_write`, `session_memory_search`, `session_memory_core`, and `session_lesson` (`src/rooms/memory/server/session-memory.ts:15-18`, `:60-67`). The knowledge RPC contract defines the UI-facing record and maintenance endpoints (`src/rooms/contracts/rpc-knowledge.ts:6-65`).

## Gotchas

Maintenance starts asynchronously after acceptance, retries observation while a child is running, and treats its stage receipt as the idempotency record (`src/rooms/memory/server/memory.ts:22-34`, `:61-83`). The data tables and field meanings are indexed in [data model](data-model.md).
