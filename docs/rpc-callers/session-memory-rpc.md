---
title: Session memory RPC
type: component
created: 2026-10-16
updated: 2026-10-20
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
  - src/rooms/contracts/index.ts
  - src/rooms/core/server/rpc-timing.ts
---

# Session memory RPC

TL;DR: Session memory RPC resolves a workspace to its project, stores subagent-audience observations, searches active memory, lists core records, and proposes lessons.

## Purpose

`sessionMemoryRpc` gives sessions on a machine access to the project memory stored by the plugin server. The RPC contract defines five strict procedures and `registerRpc` installs their handler map (`src/rooms/contracts/rpc-knowledge.ts:63-85`, `src/rooms/core/server/rpc.ts:48-49`).

## `rpcKnowledge` contract map

`rpcKnowledge` is a strict method map spread into the app-facing `rpcContract`; methods validate request and response shapes, while handlers own storage, authorization and domain behavior (`src/rooms/contracts/rpc-knowledge.ts:16-85`, `src/rooms/contracts/index.ts:18-27`). The session-memory procedures are detailed below; the other methods in this file have these inputs and outputs:

1. The contracts map declares five council methods, `get_routing_hint` and `list_rule_proposals`, then spreads the Anamnesis methods before declaring session-memory methods. The whole map is later spread into `rpcContract` alongside the other seven route families (`src/rooms/contracts/rpc-knowledge.ts:16-63`, `src/rooms/contracts/index.ts:18-27`).
2. Council list/default/get methods take project or council ids; `council_say` also accepts optional trimmed text and a decide flag, while `council_stop` returns whether a stop was requested (`src/rooms/contracts/rpc-knowledge.ts:17-41`).
3. Routing hints take a project and optional 1–365 day window, returning nullable current provider/model plus hints and counts. Rule proposal listing returns proposals, memory enable/inject state, triage counts, scan/analyzer state and events (`src/rooms/contracts/rpc-knowledge.ts:43-60`).
4. The Anamnesis spread contributes its own methods between rule proposals and session-memory declarations. Session memory then declares path resolution, write, search, core-list and lesson-proposal procedures (`src/rooms/contracts/rpc-knowledge.ts:62-85`).
5. BB validates each input before the handler map installed by `registerRpc` is called; output schemas define result shape. Nullable values and declared booleans/states are domain results, while schema errors and uncaught handler errors remain failures (`src/rooms/core/server/rpc.ts:28-51`, `src/rooms/core/server/rpc-timing.ts:12-40`).

| Procedure family | Inputs, branches and outcomes |
|---|---|
| Council reads and controls | `list_councils` and `get_council_defaults` take project id; `get_council` and `council_stop` take council id; `council_say` takes council id, optional trimmed 1–4,000 character text and optional decide flag. Results are council/default records, sequence and decide-requested, or stop-requested (`src/rooms/contracts/rpc-knowledge.ts:17-41`). |
| Routing and rule proposals | Routing hint takes project id and optional 1–365 day window, returning nullable current provider/model, hints and stats. Rule proposal listing takes project id and returns proposals, memory/triage/scan/analyzer state and events (`src/rooms/contracts/rpc-knowledge.ts:43-60`). |
| Session memory | Project resolution, write, search, core listing and lesson proposal use their declared strict request/result shapes; see the step list and failure table below (`src/rooms/contracts/rpc-knowledge.ts:63-85`). |
| Rule and memory management | Rule audience writes carry project/rule ids and audience/always values; memory record list/get, documentation status, token usage, secret issuance, Jev provider, and worktree provider methods each declare strict inputs and typed or unknown outputs (`src/rooms/contracts/rpc-knowledge.ts:86-210`). |

Malformed payloads fail schema validation before a handler runs; `timeRpcHandlers` rethrows handler failures after recording timing, and the session-memory handlers catch only the failures described below (`src/rooms/core/server/rpc-timing.ts:12-40`, `src/rooms/memory/server/session-memory.ts:18-67`).

| Session-memory route | Contract branch and declared outcome |
|---|---|
| `session_memory_project` | Requires host id and absolute path; returns nullable project id and matching scopes (`src/rooms/contracts/rpc-knowledge.ts:63-66`). |
| `session_memory_write` | Requires project, `core|note`, content 1–8,000 chars and at most 24 concepts; returns stored flag, nullable record id and nullable reason (`src/rooms/contracts/rpc-knowledge.ts:67-70`). |
| `session_memory_search` | Requires project and query 1–2,000 chars; optional limit 1–50; returns projected records (`src/rooms/contracts/rpc-knowledge.ts:72-75`). |
| `session_memory_core` | Requires project id and returns core record ids/content (`src/rooms/contracts/rpc-knowledge.ts:76-79`). |
| `session_lesson` | Requires rule 8–600 chars; optional evidence up to 1,000, up to eight scopes, writer/PM/both audience and `always`; returns proposal/repeat ids, state and adoption flag (`src/rooms/contracts/rpc-knowledge.ts:80-85`). |

## How it works

1. `session_memory_project` resolves the requested path, lists personal and standard projects, and checks each project docs place for the same host and a containing path. It returns the deepest matching place's project id and scopes, or `{projectId:null, scopes:[]}`. Project-list and docs-place errors are treated as empty lists (`src/rooms/memory/server/session-memory.ts:18-31`).
2. `session_memory_write` reads effective memory settings. If memory is disabled, it returns `stored:false`, null id and `memory_disabled`; otherwise it parses one `{kind,content,concepts}` candidate with budget checks disabled at parse time (`src/rooms/memory/server/session-memory.ts:32-37`).
3. A parse error is caught and returned in `reason`. The parser checks kind/content/concepts and candidate token budgets; this handler sets those budget checks to effectively unbounded values, leaving the store to apply configured retention budgets. If parsing succeeds, it stores audience `subagent`, trust `observed`, origin `session`, and a hash of the optional source marker. It returns the inserted or corroborated id; a no-insert result is `corroborated` or `duplicate`, and storage exceptions return their message (`src/rooms/memory/server/session-memory.ts:35-48`, `packages/memory-core/src/candidates.ts:37-63`, `packages/memory-core/src/store.ts:83-110`).
4. `session_memory_search` applies configured search engine and personal-bot settings, searches the `subagent` audience including observed records, and projects each result to id, kind, content and concepts, after the relevance floor (`docs/memory.md`); when nothing clears it the output also carries `nothingRelevant: true` and a `message`. Omitted limit defaults to eight (`src/rooms/memory/server/session-memory.ts:50-53`).
5. `session_memory_core` selects active core records for the project and `subagent` audience whose validity has not expired, ordered by creation time (`src/rooms/memory/server/session-memory.ts:55-59`).
6. `session_lesson` upserts a lesson proposal. The upsert increments occurrences for a similar pending or accepted rule; only a newly created proposal is offered for adoption. The handler reloads the proposal and returns its id, repeat id, current state or `proposed` fallback, and adopted flag (`src/rooms/memory/server/session-memory.ts:60-66`, `packages/run-insights/src/rules.ts:314-338`).

| Procedure | Branches and result | Failure behavior |
|---|---|---|
| `session_memory_project` | Matching host/path returns deepest project place; no match returns null project and empty scopes. | Project and docs-place listing failures are swallowed and treated as no match (`src/rooms/memory/server/session-memory.ts:18-31`). |
| `session_memory_write` | Disabled, parsed-and-stored, corroborated, or duplicate. Contract caps content at 8,000 characters, concepts at 24 items of up to 100 characters, and source at 300 (`src/rooms/contracts/rpc-knowledge.ts:67-70`). | Parse and store exceptions become `{stored:false,id:null,reason}`; memory settings/database setup failures before those `try` blocks reject (`src/rooms/memory/server/session-memory.ts:32-48`). |
| `session_memory_search` | Returns projected search records; omitted limit is eight and schema allows 1–50 when supplied. | Search/database errors are not caught in this handler and reject the call (`src/rooms/contracts/rpc-knowledge.ts:72-75`, `src/rooms/memory/server/session-memory.ts:50-53`). |
| `session_memory_core` | Returns active, unexpired subagent core records from the query result. | The handler returns the database rows directly; it has no local catch or row-validation fallback (`src/rooms/memory/server/session-memory.ts:55-59`). |
| `session_lesson` | New proposal may be adopted; repeat returns existing proposal status and `adopted:false`. | The handler does not catch errors from proposal upsert or adoption (`src/rooms/memory/server/session-memory.ts:60-66`). |

## Business rules

Writes use `subagent` audience regardless of caller identity; observed session notes are included in session search (`src/rooms/memory/server/session-memory.ts:38-53`). Project resolution compares both host id and path containment and chooses the longest matching place path (`src/rooms/memory/server/session-memory.ts:23-30`). Core listing filters expired records at read time (`src/rooms/memory/server/session-memory.ts:55-58`).

## Public API or commands

Procedures are `session_memory_project`, `session_memory_write`, `session_memory_search`, `session_memory_core`, and `session_lesson`; their input and output schemas are in `rpcKnowledge` (`src/rooms/contracts/rpc-knowledge.ts:63-85`).

## Gotchas

- Writes parse with very large temporary budgets, then `storeMemoryRecords` applies the configured budgets. The parse step therefore validates the candidate but does not itself enforce the project's retained-memory budget (`src/rooms/memory/server/session-memory.ts:35-43`).
- Only project/path discovery catches lookup failures. Search, core-list and lesson handlers have no local catch around their database operations, so those errors reject to the RPC caller (`src/rooms/memory/server/session-memory.ts:18-31`, `:50-66`).
- `session_lesson` can return `state: "proposed"` when the proposal lookup after upsert returns no row (`src/rooms/memory/server/session-memory.ts:61-65`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
