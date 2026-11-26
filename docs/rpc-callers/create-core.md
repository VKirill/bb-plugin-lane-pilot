---
title: Server core construction
type: component
created: 2026-10-16
updated: 2026-11-26
status: active
confidence: medium
tags: [server, core, host-calls]
sources:
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/core.ts
  - src/rooms/registry.ts
  - src/rooms/schedule/server/handlers/board-clock.ts
  - packages/host-calls/src/host-jobs.ts
  - packages/thread-observe/src/signals.ts
  - server.ts
---

# Server core construction

TL;DR: `createCore` builds the shared server context, host client wrappers, settings helpers, and runtime utilities consumed by room handlers; `server.ts` mounts registered rooms via `src/rooms/registry.ts` and starts the single `engine-clock`.

## Purpose

`createCore(bb, db)` is the common dependency object for server modules. `server.ts` opens storage, calls it once, then composes room services and registers their tools, CLI, and RPCs through the room registry (`server.ts`, `src/rooms/registry.ts`, `src/rooms/core/server/core.ts:31`).

## How it works

1. It creates disposal state, registers a hook to mark the core disposed, wraps logger methods with secret redaction on a best-effort basis, installs illegal-transition logging, mounts realtime/helper signals, and creates owner-ask support (`src/rooms/core/server/core.ts:31-47`).
2. It creates the raw host client from `hostContract`, sets up deploy-drain tracking and worker-exit job reconciliation (`src/rooms/core/server/core.ts:48-72`).
3. It wraps `host.call` so each call inherits any active schedule abort signal, enters deploy-drain tracking, strips private options (`job`, `jobKey`, `worktreeOwner`, `cancelOnAbort`), routes declared job kinds through `createHostJobs` (unless `LANE_PILOT_HOST_JOBS=0`), and updates the worktree registry (`src/rooms/core/server/core.ts:73-99`).
4. It constructs native-install wrappers, serialized KV helpers, settings inheritance, and workspace/run context helpers (`src/rooms/core/server/core.ts`).

### Plugin factory & single clock

1. `plugin(bb)` opens the SQLite database (applying `src/rooms/migrations.ts`), installs thread signals, builds `createCore`, creates the shared services bag, and registers rooms via `src/rooms/registry.ts` (`server.ts`).
2. Instead of multiple per-minute timers, startup registers one isolated interval for `engine-clock` (`src/rooms/schedule/server/handlers/board-clock.ts`) which drives workflow timeouts, deadline waits, and schedule-board rows.

| Branch | Condition | Result or failure |
|---|---|---|
| Thread wakeups | BB accepts thread lifecycle subscriptions. | Events wake watchers; without support the watcher polling path remains (`packages/thread-observe/src/signals.ts`). |
| Background host job | Environment permits jobs and method is a job kind; `runSandboxedCommand` requires `job: true`. | Job wrapper returns host result or rejects on job error, abort, disposal or timeout (`src/rooms/core/server/core.ts:88-90`, `packages/host-calls/src/host-jobs.ts`). |
| Logger wrapping | Logger method exists and assignment is permitted. | Redaction wrapper is assigned; frozen logger assignment failure is swallowed (`src/rooms/core/server/core.ts:36-39`). |

## Business rules

The core host wrapper attaches the current schedule abort signal only if the call did not already supply one; it strips internal job and worktree options before invoking the BB host API (`src/rooms/core/server/core.ts:77-92`).

## Public API or commands

The returned object is the inferred `ServerCore` API grouping BB/DB access, runtime state, realtime, owner asks, logging, secrets, host/native installers, deploy drain, KV/settings, and workspace/run helpers (`src/rooms/core/server/core.ts`, `src/rooms/core/server/rpc.ts`).

## Gotchas

- `createCore` does not catch general initialization failures from its constructors; only the logger assignment and best-effort helpers have local fallback handling (`src/rooms/core/server/core.ts:31-47`).
- `LANE_PILOT_HOST_JOBS=0` disables background host jobs in the core wrapper; the option never reaches the host (`src/rooms/core/server/core.ts:87-90`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
