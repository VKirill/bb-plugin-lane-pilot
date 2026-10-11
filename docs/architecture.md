---
title: Lane Pilot architecture
type: architecture
created: 2026-09-30
updated: 2026-10-11
status: active
confidence: medium
tags: [architecture, runtime, monorepo]
sources:
  - server.ts
  - package.json
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/services.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/native-wiring.ts
  - src/rooms/core/server/lifecycle-events.ts
  - tests/architecture/boundaries.test.ts
  - src/rooms/contracts/index.ts
  - src/rooms/contracts/host.ts
  - src/rooms/contracts/rpc-shell.ts
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/contracts/rpc-ops.ts
  - src/rooms/contracts/rpc-knowledge.ts
  - src/rooms/contracts/rpc-workflow.ts
  - src/rooms/storage/database.ts
  - packages/jev/src/run.ts
  - packages/host-calls/src/run-on-host.ts
  - packages/thread-observe/src/completion.ts
  - packages/handoff/src/messages.ts
  - app.tsx
---

# Lane Pilot architecture

TL;DR: The BB plugin server owns SQLite and room services; the app UI and host workers communicate with it through typed RPC and host contracts.

## System context and containers

```mermaid
C4Container
  title Lane Pilot runtime context
  Person(owner, "Project owner", "Uses BB chats, composer, and plugin pages")
  System_Boundary(lp, "Lane Pilot") {
    Container(app, "Plugin UI", "React / BB app SDK", "Composer action and project pages")
    Container(server, "Plugin server", "TypeScript / BB plugin SDK", "Room services, RPC, schedules")
    ContainerDb(db, "Plugin SQLite", "SQLite", "Runs, settings, receipts, memory and domain records")
  }
  System_Ext(bb, "BB server and host workers", "Thread, provider, environment, and machine APIs")
  Rel(owner, app, "Uses")
  Rel(app, server, "Typed RPC")
  Rel(server, bb, "BB SDK and host contract calls")
  Rel(server, db, "Reads and writes")
```

The UI and server entries are declared by the package's BB manifest (`package.json:8-18`). The server uses BB's plugin storage database and runs migrations during startup (`src/rooms/storage/database.ts:323-327`). The UI receives methods from the assembled `rpcContract`, while host calls use `hostContract` (`src/rooms/contracts/index.ts:1-26`, `src/rooms/contracts/host.ts:6-15`).

## Startup and service composition

1. BB calls `plugin(bb)`. The entry opens SQLite and installs thread signals, then creates the shared core (`server.ts:55-60`).
2. The core installs disposal state, log redaction, realtime notifications, owner-interaction handling, host RPC and background host jobs (`src/rooms/core/server/core.ts:31-49`, `:87-100`).
3. The entry mounts native message dispatch and environment hooks, then fills a shared `Services` object with room-owned factories for writer, workflow, QA, docs, memory, council, world, stability, and scheduling (`server.ts:61-91`, `src/rooms/core/server/native-wiring.ts:10-34`).
4. Lifecycle events, RPC, tools, CLI, world assets, Anamnesis, and the native worktree provider are registered after services exist (`server.ts:92-110`).
5. The entry schedules run reconciliation, silent-writer checks, and worktree cleanup (`server.ts:111-139`).

`createCore` wraps the host client with job handling and the active schedule abort signal; calls made inside an isolated schedule run carry that signal (`src/rooms/core/server/core.ts:91-100`). The service bag's shared types are defined in `src/rooms/core/server/services.ts`.

## Dependency boundaries

The import boundary test defines public room files as `index.ts`, `server/index.ts`, and `ui/index.ts`, restricts cross-room imports to those files, and rejects package imports into plugin `src/` (`tests/architecture/boundaries.test.ts:12-16`, `:25-40`, `:64-80`, `:122-131`). Entry wiring follows that boundary: `server.ts` imports room server exports and `app.tsx` imports UI-facing room exports (`server.ts:1-48`, `app.tsx:1-50`).

The test's deep-import baseline is recorded in `tests/architecture/deep-imports.json` (`tests/architecture/boundaries.test.ts:122-131`).

## RPC composition and event wiring

`rpcContract` combines shell, native-agent, runs, settings, operations, knowledge, workflow, and world schemas (`src/rooms/contracts/index.ts:17-26`). `registerRpc` combines handlers from each room and installs one timed BB RPC registration (`src/rooms/core/server/rpc.ts:26-50`). Contracts use strict Zod input/output shapes; for example, run-list requests carry project, offset, limit and optional section (`src/rooms/contracts/rpc-runs.ts:33-40`), and the workflow contract describes drafts, tests and publication operations (`src/rooms/contracts/rpc-workflow.ts:5-90`). The operations contract and its route groups are detailed in [RPC and host-call contracts](rpc-callers.md#how-it-works).

`mountNativeWiring` registers the mention provider, `message.dispatch` handler, Claude environment contribution, OpenCode shim, BB shim, and retry handling for dropped provider streams (`src/rooms/core/server/native-wiring.ts:10-58`). `mountLifecycleEvents` adds event listeners only when the BB event API exists and `LANE_PILOT_THREAD_SIGNALS` is not `0`; missing event names are logged and periodic sweeps remain the fallback (`src/rooms/core/server/lifecycle-events.ts:22-37`). It closes runs when their PM thread is archived or deleted and notifies PMs when an attempt is waiting on an owner interaction (`src/rooms/core/server/lifecycle-events.ts:39-72`).

The host contract declares plugin-to-host operations including native install, git ownership and host jobs (`src/rooms/contracts/host.ts:6-25`). `runOnHost` is a typed convenience wrapper for `runCommand`; it passes the same host id in the call input and call options and defaults the transport wait to command timeout plus five seconds (`packages/host-calls/src/run-on-host.ts:8-31`).

## Data ownership

The shared SQLite migration array includes stores exported by Jev, council, handoff, run-insights, workflow engine, schedule, learning, and world domains (`src/rooms/storage/database.ts:1-22`, `:230-320`). The [data model overview](data-model.md) links to domain tables. Workspace-specific tables belong to their owning package documentation, including [workflow engine](../packages/workflow-engine/docs/overview.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot overview](overview.md)
- [World simulation overview](../packages/world-sim/docs/overview.md)
