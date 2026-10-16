---
title: Session memory RPC
type: component
created: 2026-10-16
updated: 2026-10-16
status: active
confidence: medium
tags: [rpc, memory, sessions]
sources:
  - src/rooms/memory/server/session-memory.ts
  - src/rooms/contracts/rpc-knowledge.ts
  - src/rooms/core/server/rpc.ts
  - packages/memory-core/src/candidates.ts
  - packages/memory-core/src/store.ts
  - packages/run-insights/src/rules.ts
---

# Session memory RPC

TL;DR: Session memory RPC resolves a workspace to its project, stores subagent-audience observations, searches active memory, lists core records, and proposes lessons.

## Purpose

`sessionMemoryRpc` gives sessions on a machine access to the project memory stored by the plugin server. The RPC contract defines five strict procedures and `registerRpc` installs their handler map (`src/rooms/contracts/rpc-knowledge.ts:63-85`, `src/rooms/core/server/rpc.ts:46-47`).

## How it works

1. `session_memory_project` resolves the requested path, lists personal and standard projects, and checks each project docs place for the same host and a containing path. It returns the deepest matching place's project id and scopes, or `{projectId:null, scopes:[]}`. Project-list and docs-place errors are treated as empty lists (`src/rooms/memory/server/session-memory.ts:18-31`).
2. `session_memory_write` reads effective memory settings. If memory is disabled, it returns `stored:false`, null id and `memory_disabled`; otherwise it parses one `{kind,content,concepts}` candidate with budget checks disabled at parse time (`src/rooms/memory/server/session-memory.ts:32-37`).
3. A parse error is caught and returned in `reason`. The parser checks kind/content/concepts and candidate token budgets; this handler sets those budget checks to effectively unbounded values, leaving the store to apply configured retention budgets. If parsing succeeds, it stores audience `subagent`, trust `observed`, origin `session`, and a hash of the optional source marker. It returns the inserted or corroborated id; a no-insert result is `corroborated` or `duplicate`, and storage exceptions return their message (`src/rooms/memory/server/session-memory.ts:35-48`, `packages/memory-core/src/candidates.ts:37-63`, `packages/memory-core/src/store.ts:83-110`).
4. `session_memory_search` applies configured search engine and personal-bot settings, searches the `subagent` audience including observed records, and projects each result to id, kind, content and concepts. Omitted limit defaults to eight (`src/rooms/memory/server/session-memory.ts:50-53`).
5. `session_memory_core` selects active core records for the project and `subagent` audience whose validity has not expired, ordered by creation time (`src/rooms/memory/server/session-memory.ts:55-59`).
6. `session_lesson` upserts a lesson proposal. The upsert increments occurrences for a similar pending or accepted rule; only a newly created proposal is offered for adoption. The handler reloads the proposal and returns its id, repeat id, current state or `proposed` fallback, and adopted flag (`src/rooms/memory/server/session-memory.ts:60-66`, `packages/run-insights/src/rules.ts:314-338`).

| Procedure | Branches and result | Failure behavior |
|---|---|---|
| `session_memory_project` | Matching host/path returns deepest project place; no match returns null project and empty scopes. | Project and docs-place listing failures are swallowed and treated as no match (`src/rooms/memory/server/session-memory.ts:18-31`). |
| `session_memory_write` | Disabled, parsed-and-stored, corroborated, or duplicate. Contract caps content at 8,000 characters, concepts at 24 items of up to 100 characters, and source at 300 (`src/rooms/contracts/rpc-knowledge.ts:67-70`). | Parse and store exceptions become `{stored:false,id:null,reason}`; memory settings/database setup failures before those `try` blocks reject (`src/rooms/memory/server/session-memory.ts:32-48`). |
| `session_memory_search` | Returns projected search records; omitted limit is eight and schema allows 1–50 when supplied. | Search/database errors are not caught in this handler and reject the call (`src/rooms/contracts/rpc-knowledge.ts:72-75`, `src/rooms/memory/server/session-memory.ts:50-53`). |
| `session_memory_core` | Returns active, unexpired subagent core records. | Database errors reject; invalid rows are not converted to a fallback result (`src/rooms/memory/server/session-memory.ts:55-59`). |
| `session_lesson` | New proposal may be adopted; repeat returns existing proposal status and `adopted:false`. | Upsert or adoption errors reject the call (`src/rooms/memory/server/session-memory.ts:60-66`). |

## Business rules

Writes use `subagent` audience regardless of caller identity; observed session notes are included in session search (`src/rooms/memory/server/session-memory.ts:38-53`). Project resolution compares both host id and path containment and chooses the longest matching place path (`src/rooms/memory/server/session-memory.ts:23-30`). Core listing filters expired records at read time (`src/rooms/memory/server/session-memory.ts:55-58`).

## Public API or commands

Procedures are `session_memory_project`, `session_memory_write`, `session_memory_search`, `session_memory_core`, and `session_lesson`; their input and output schemas are in `rpcKnowledge` (`src/rooms/contracts/rpc-knowledge.ts:63-85`).

## Gotchas

- Writes parse with very large temporary budgets, then `storeMemoryRecords` applies the configured budgets. The parse step therefore validates the candidate but does not itself enforce the project's retained-memory budget (`src/rooms/memory/server/session-memory.ts:35-43`).
- Only project/path discovery catches lookup failures. Search, core-list and lesson operations can reject to the RPC caller (`src/rooms/memory/server/session-memory.ts:18-31`, `:50-66`).
- `session_lesson` can return `state: "proposed"` when the proposal lookup after upsert returns no row (`src/rooms/memory/server/session-memory.ts:61-65`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
