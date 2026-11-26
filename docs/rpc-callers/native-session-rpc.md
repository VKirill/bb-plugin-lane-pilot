---
title: Native session and activation RPC
type: component
created: 2026-10-20
updated: 2026-10-29
status: active
confidence: high
tags: [rpc, native-agent, activation]
sources:
  - src/rooms/contracts/rpc-native.ts
  - src/rooms/runs/server/handlers/runs-rpc.ts
  - src/rooms/native-agent/server/services/native-profile.ts
  - src/rooms/runs/server/services/run-finish.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/contracts/index.ts
  - src/rooms/core/server/rpc.ts
---

# Native session and activation RPC

TL;DR: `rpcNative` declares run finishing, PM activation and native-agent session methods; the run room supplies handlers and stores native selections by token.

## Purpose

This page follows the native route contract through its handlers and the profile-selection helper called by `prepare_native_session`.

## How it works

1. BB checks each request against a strict method schema: `finish_run`, `activate_pm`, `activation_context`, native installation status/start, `prepare_native_session`, and `list_helper_threads` (`src/rooms/contracts/rpc-native.ts`).
2. `finish_run` passes project and run ids to `finishRunSafely`, then returns that run as closed (`src/rooms/runs/server/handlers/runs-rpc.ts`, `src/rooms/runs/server/services/run-finish.ts`). `activate_pm` delegates project, source thread, agent, and optional environment snapshot to the activation service with source `bb`.
3. `activation_context` accepts nullable project and thread ids, returning visible project choices, binding status, main-agent support, writer selection, live run, thread metadata and required-session-policy capability.
4. `prepare_native_session` normalizes the agent id, calls `storeNativeSelection`, and returns the UUID token, display label, normalized id and profile mode (`src/rooms/native-agent/server/services/native-profile.ts`).

| Route or branch | Outcome | Failure or alternate path |
|---|---|---|
| `finish_run` | Returns `{projectId, finishedRunIds:[runId], closed:true}` after safe close. | Wrong project, remaining open attempts, or unavailable PM status rejects (`src/rooms/runs/server/services/run-finish.ts`). |
| `activate_pm` | Delegates to activation; success carries thread and run ids and may include new bookkeeping exclusions. | Invalid snapshot fails schema validation; activation service rejection propagates. |
| Activation context | Null project/thread are accepted; unavailable fields remain nullable. | Thread metadata errors become null (`src/rooms/runs/server/handlers/runs-rpc.ts`). |
| Native install | Start reports `started`; status returns install status and nullable error. | Start only launches when no pending install exists. |
| `storeNativeSelection` | Known profile becomes a token-backed selection under `native-selection:<token>`. | Compiled-profile corruption and unknown profile throw (`src/rooms/native-agent/server/services/native-profile.ts`). |
| `list_helper_threads` | Returns unarchived children, queued ids and an optional graph for the open run. | Uncaught handler errors reject through `timeRpcHandlers`. |

## Business rules

Profile mode is `session-override` when the effective profile differs from stock or is a non-stock profile; a stock profile with no edited source uses `installed` mode (`src/rooms/native-agent/server/services/native-profile.ts`).

## Public API or commands

`rpcNative` is one of the maps assembled into `rpcContract` and registered via the room registry (`src/rooms/contracts/index.ts`, `src/rooms/core/server/rpc.ts`).

## Gotchas

- `nativeAgentCliId` normalization happens before both owned-profile lookup and stock-profile lookup (`src/rooms/native-agent/server/services/native-profile.ts`).
- The native selection KV write occurs after record preparation; a failed write prevents returning its token.

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
