---
title: RPC route execution details
type: component
created: 2026-10-14
updated: 2026-10-14
status: active
confidence: medium
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
4. Documentation status returns place mode `auto|on|off`, cadence `nightly|weekly|paused`, a nullable verdict, and nullable last-read time. Token usage accepts `7d|14d|30d|month`; rebuild returns started metadata or `{started:false}` when it does not start (`src/rooms/contracts/rpc-knowledge.ts:103-114`, `:133-177`).
5. Secret issuance reports names and consumer metadata, never secret values. Jev status reports chosen/effective provider and key presence; provider test has structured `ok`, latency, and nullable error fields. Worktree-provider methods report or clear per-host breaker state (`src/rooms/contracts/rpc-knowledge.ts:179-210`).

| Branch | Outcome | Failure or absence |
|---|---|---|
| Council, routing, rules, memory, docs | Declared collections and records; optional or nullable fields represent missing domain data. | Strict input validation rejects extra keys and values outside declared bounds or enums. |
| Token usage | Query, sync, and rebuild results; rebuild carries backup and row-clear metadata when it starts. | A concurrent rebuild is represented by `{started:false}`. |
| Provider and secret | Provider identity and key presence, issuance metadata, test result, or breaker state. | No route returns a provider key; invalid provider ids or malformed inputs fail schema validation. |

### `rpcWorkflow`

1. Workflow reads list workflows, retrieve a workflow or snapshot, and page run history. A missing workflow or snapshot is represented by nullable results; history takes cursor and a 1–50 limit with a default of 20 (`src/rooms/contracts/rpc-workflow.ts:5-28`).
2. Node rerun takes run and node ids. Live start takes workflow id, source, inputs, and optional live-trial acknowledgment; preflight returns missing inputs, requirement issues, and named secret requests (`src/rooms/contracts/rpc-workflow.ts:29-52`).
3. Live mode branches on source: `manual` can start directly, while `telegram` carries Telegram input and trigger validation outcomes. The result schema exposes success/run data or refusal details (`src/rooms/contracts/rpc-workflow.ts:34-52`).
4. Dry-run stubs every external action and returns one nullable trial result plus the stubbed-action list; tests run every test case on stubs and return case results, `green`, and status. Draft routes list/get, create `edit` or `duplicate` drafts, patch, restore, test, and publish; patch and restore can include an expected version (`src/rooms/contracts/rpc-workflow.ts:54-95`).
5. Architect start accepts optional project, section, and draft ids and returns its thread/project plus `reused`; executor, model override/catalog, and capability routes expose or update step configuration (`src/rooms/contracts/rpc-workflow.ts:97-130`).

| Mode | Output and branch | Failure representation |
|---|---|---|
| Live start | Manual or Telegram source; result includes started run fields when accepted. | Preflight issues and start refusal use declared reason/missing-input/requirement fields. |
| Dry run and test | Dry run returns one nullable result and stubbed actions; tests return all case results plus `green` and status. | Trial failures remain case results; invalid payloads fail schema validation (`src/rooms/contracts/rpc-workflow.ts:54-62`). |
| Draft | Create selects `edit` or `duplicate`; patch and restore optionally guard by expected version. | Version and business conflicts are represented by each operation's declared result; handler rejection propagates. |
| Architect | Returns thread and project identifiers and whether a living thread was reused. | The schema does not turn handler or transport rejection into a successful result. |

### `rpcRuns`

1. `task_board` returns task/workflow rows; `task_card` accepts a task id or null workflow-card id and may return null (`src/rooms/contracts/rpc-runs.ts:8-35`).
2. Run-card lookup can be nullable. Stage listing returns summaries, while `get_stage_result` returns `found` and a nullable result (`src/rooms/contracts/rpc-runs.ts:37-75`).
3. `list_runs` requires project id, optional section, nonnegative integer offset, and integer limit 1–200; optional `pinOpen` controls open-run pinning (`src/rooms/contracts/rpc-runs.ts:64-67`).
4. `get_screen` takes project, optional section, and optional run limit 1–200. It includes screen settings and recent runs, an optional writer binding with five resolution states, and a nullable writer trace (`src/rooms/contracts/rpc-runs.ts:98-117`, `:126-163`).

| Route | Branch and result | Failure or absence |
|---|---|---|
| Task/run card | Card may be returned for a known run/task. | `task_card` and run-card lookup can return null when the record is absent (`src/rooms/contracts/rpc-runs.ts:22-43`). |
| Stage result | Separately fetched result body and `found` flag. | Missing result uses `found:false` and `result:null`; invalid ids fail validation (`src/rooms/contracts/rpc-runs.ts:68-75`). |
| Run paging | Required offset and 1–200 limit. | Negative offset, non-integer values, or out-of-range limit fail schema validation (`src/rooms/contracts/rpc-runs.ts:64-67`). |
| Screen binding | `resolved`, `ambiguous`, `setup_required`, `offline`, or `catalog_unavailable`. | These are domain binding states; nullable host/path fields carry unresolved states (`src/rooms/contracts/rpc-runs.ts:98-117`). |

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

The maps are registered through the shared `rpcContract`; route implementation is supplied by domain handler factories (`src/rooms/contracts/index.ts:17-26`, `src/rooms/core/server/rpc.ts:27-51`).

## Gotchas

A schema describes accepted payloads and result shapes. It does not implement authorization, persistence policy, or retry behavior; those remain in the handler and called services (`src/rooms/memory/server/session-memory.ts:32-67`, `src/rooms/core/server/rpc-timing.ts:12-40`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](rpc-callers.md)
