---
title: Native session and activation RPC
type: component
created: 2026-10-20
updated: 2026-10-20
status: active
confidence: high
tags: [rpc, native-agent, activation]
sources:
  - src/rooms/contracts/rpc-native.ts
  - src/rooms/runs/server/rpc/runs.ts
  - src/rooms/native-agent/server/native-profile.ts
  - src/rooms/runs/server/run-finish.ts
  - src/rooms/native-install/native-install-lifecycle.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/contracts/index.ts
  - src/rooms/core/server/rpc.ts
---

# Native session and activation RPC

TL;DR: `rpcNative` declares run finishing, PM activation and native-agent session methods; the run room supplies handlers and stores native selections by token.

## Purpose

This page follows the native route contract through its handlers and the profile-selection helper called by `prepare_native_session`.

## How it works

1. BB checks each request against a strict method schema. The first routes are `finish_run`, `activate_pm`, and `activation_context`; later routes start or inspect native installation, prepare a selected agent session, and list helper threads (`src/rooms/contracts/rpc-native.ts:4-14`, `:79-145`).
2. `finish_run` passes project and run ids to `finishRunSafely`, then returns that run as closed. `activate_pm` delegates project, source thread, agent, and optional environment snapshot to the activation service with source `bb` (`src/rooms/runs/server/rpc/runs.ts:28-34`).
3. The activation snapshot variant requires `status:"ready"`, scope `new-thread`, project/provider/model/reasoning values, and one of the environment descriptions: reuse, host workspace, project default or provider provisioning. A parallel `environmentRequest` union records the requested environment form; optional provenance carries the resolved project and section/host/path data (`src/rooms/contracts/rpc-native.ts:9-80`).
4. `activation_context` accepts nullable project and thread ids, returning the visible project choices, binding status, main-agent support, writer selection, optional main agent, live run, thread metadata and required-session-policy capability (`src/rooms/contracts/rpc-native.ts:82-104`).
5. Native installation start delegates to `nativeInstaller.start`; status delegates to `nativeInstaller.status`. Preparing a session normalizes the agent id, calls `storeNativeSelection`, and returns the UUID token, display label, normalized id and profile mode (`src/rooms/runs/server/rpc/runs.ts:35-44`).
6. `storeNativeSelection` loads an owned profile, rejects an explicitly corrupt compiled profile, attempts effective compilation, and checks the stock profile catalog. If neither compiled nor stock profile exists it throws. Otherwise it derives `installed` or `session-override`, prepares a record (optionally with parent run), stores it under `native-selection:<token>`, and returns the record plus description (`src/rooms/native-agent/server/native-profile.ts:12-30`).

| Route or branch | Outcome | Failure or alternate path |
|---|---|---|
| `finish_run` | Returns `{projectId, finishedRunIds:[runId], closed:true}` after safe close. | Wrong project, remaining open attempts, or unavailable PM status rejects through the handler (`src/rooms/runs/server/rpc/runs.ts:28-30`, `src/rooms/runs/server/run-finish.ts:175-199`). |
| `activate_pm` | Delegates to activation; success carries thread and run ids and may include new bookkeeping exclusions (`src/rooms/contracts/rpc-native.ts:79-80`, `src/rooms/runs/server/rpc/runs.ts:32-34`). | Invalid snapshot fails schema validation; activation service rejection propagates. |
| Activation context | Null project/thread are accepted; metadata fields with no match are nullable and binding status has five declared states (`src/rooms/contracts/rpc-native.ts:82-104`). | Handler-specific unavailable thread metadata is returned as null (`src/rooms/runs/server/rpc/runs.ts:252-302`). |
| Native install | Start reports `started`; status returns install status and nullable error (`src/rooms/contracts/rpc-native.ts:106-113`). | Start only launches when no pending install exists; status reports `installing`, host status or `offline` (`src/rooms/runs/server/rpc/runs.ts:35-39`, `src/rooms/native-install/native-install-lifecycle.ts:76-85`). |
| `storeNativeSelection` | A known profile becomes a token-backed selection, with optional parent run id. | Compiled-profile corruption and unknown profile throw; effective compiler exceptions are caught so stock fallback remains possible (`src/rooms/native-agent/server/native-profile.ts:12-30`). KV write or record preparation errors reject. |
| `list_helper_threads` | Returns unarchived children, queued ids and an optional graph for the open run (`src/rooms/contracts/rpc-native.ts:127-144`). | Listing failure returns rows collected so far; route-wide uncaught handler errors reject (`src/rooms/runs/server/rpc/runs.ts:46-103`, `src/rooms/core/server/rpc-timing.ts:12-40`). |

## Business rules

Profile mode is `session-override` when the effective profile differs from stock or is a non-stock profile; a stock profile with no edited source uses `installed` mode (`src/rooms/native-agent/server/native-profile.ts:18-25`).

## Public API or commands

`rpcNative` is one of the maps assembled into `rpcContract` and registered by the run handlers (`src/rooms/contracts/index.ts:17-26`, `src/rooms/core/server/rpc.ts:30-35`).

## Gotchas

- `nativeAgentCliId` normalization happens before both owned-profile lookup and stock-profile lookup, so the lookup key can differ from the submitted id (`src/rooms/native-agent/server/native-profile.ts:12-20`).
- The native selection KV write occurs after record preparation; a failed write prevents the RPC from returning its token (`src/rooms/native-agent/server/native-profile.ts:21-30`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
