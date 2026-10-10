---
title: RPC and host-call contracts
type: component
created: 2026-09-30
updated: 2026-10-10
status: active
confidence: medium
tags: [rpc, contracts, host-api]
sources:
  - src/rooms/core/server/rpc.ts
  - src/rooms/contracts/index.ts
  - src/rooms/contracts/host.ts
  - src/rooms/contracts/rpc-shell.ts
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/contracts/rpc-knowledge.ts
  - src/rooms/contracts/rpc-workflow.ts
  - src/rooms/memory/server/session-memory.ts
  - packages/host-calls/src/run-on-host.ts
  - packages/handoff/src/messages.ts
  - scripts/record_and_guard.py
  - server.ts
  - src/rooms/core/server/core.ts
  - src/rooms/memory/server/memory.ts
---

# RPC and host-call contracts

TL;DR: The contracts room assembles strict UI RPC schemas and a separate host contract; the core registers one implementation object from domain handlers.

## Purpose

Keep BB app-to-server calls and plugin-server-to-host calls typed independently. The app RPC contract is assembled from shell, native, runs, settings, operations, knowledge, workflow, and world contracts (`src/rooms/contracts/index.ts:17-26`).

## How it works

1. `rpcContract` combines each room contract fragment and is the public RPC type source for UI components (`src/rooms/contracts/index.ts:1-26`).
2. `registerRpc` combines matching room handler objects, applies timing instrumentation, and registers the assembled contract once (`src/rooms/core/server/rpc.ts:26-50`).
3. `rpcShell` covers preferences, project/section listings, global settings, and agent profiles (`src/rooms/contracts/rpc-shell.ts:5-18`, `:20-60`, `:74-109`).
4. `rpcRuns` exposes run cards, run listing, stage results, helper-access view, and the current project screen (`src/rooms/contracts/rpc-runs.ts:5-43`, `:45-90`).
5. `rpcKnowledge` describes memory list, mutation, search, maintenance and related project records (`src/rooms/contracts/rpc-knowledge.ts:6-65`). `rpcWorkflow` defines execution, test, draft, version restore and publish operations (`src/rooms/contracts/rpc-workflow.ts:5-90`).
6. Host operations use a separate `hostContract`, bound through BB's experimental host client (`src/rooms/contracts/host.ts:6-15`, `src/rooms/core/server/core.ts:48-49`).

## Modes, variants and failures

| Contract | Inputs and result | Failure handling |
|---|---|---|
| App RPC | Strict Zod schemas; method input and output shape are declared in each `rpc-*` module (`src/rooms/contracts/rpc-shell.ts:8-18`, `src/rooms/contracts/rpc-runs.ts:33-43`). | Invalid payloads fail contract validation before the handler result reaches the UI. |
| Host RPC | Host methods include `requestedHostId`; output is checked against typed schemas (`src/rooms/contracts/host.ts:6-15`). | Host call errors propagate to the calling room or are converted there into domain result states. |
| Session memory | Path lookup, write, search, core listing and lesson proposal (`src/rooms/memory/server/session-memory.ts:15-67`). | Writes return explicit disabled, parse, duplicate/corroboration or storage outcomes (`:32-48`). |
| Handoff message | Recipient receives objective, acceptance criteria, inputs, budget and a fixed JSON receipt template (`packages/handoff/src/messages.ts:12-37`). | Invalid JSON blocks are skipped; no matching card id returns null (`packages/handoff/src/messages.ts:40-55`). |

## Business rules

RPC schemas use strict object validation at method boundaries (`src/rooms/contracts/rpc-shell.ts:8-18`, `src/rooms/contracts/rpc-runs.ts:7-21`). The run card's stage and task state values are summarized for UI display; receipt details are fetched through a separate method (`src/rooms/contracts/rpc-runs.ts:7-43`). Session memory records are written for the `subagent` audience (`src/rooms/memory/server/session-memory.ts:38-45`).

## Public API or commands

`rpcContract` is exported from the contracts room and re-exported by `server.ts` for BB discovery (`src/rooms/contracts/index.ts:15-26`, `server.ts:52-53`). `hostContract` is the client contract for host procedures (`src/rooms/contracts/index.ts:15-16`, `src/rooms/contracts/host.ts:6-15`). `runOnHost` wraps `runCommand` and supplies the default host transport deadline (`packages/host-calls/src/run-on-host.ts:8-31`).

`main` in `record_and_guard.py` records the incoming hook payload and forwards normalized PM identity to the guard script when `LANE_PILOT_PM=1` (`scripts/record_and_guard.py:19-49`).

## Gotchas

The RPC contract is a shape contract; authorization and ownership checks remain in handlers. For example, memory maintenance checks PM role, run id, project, task and acceptance receipt before starting (`src/rooms/memory/server/memory.ts:37-47`). Host ids appear in both `runOnHost`'s request and call options because the BB client contract needs both (`packages/host-calls/src/run-on-host.ts:1-5`, `:26-31`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot overview](overview.md)
