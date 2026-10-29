---
title: Server core construction
type: component
created: 2026-10-16
updated: 2026-10-29
status: active
confidence: low
tags: [server, core, host-calls]
sources:
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/services.ts
  - src/rooms/harness/server/index.ts
  - packages/host-calls/src/host-jobs.ts
  - packages/thread-observe/src/signals.ts
  - server.ts
---

# Server core construction

TL;DR: `createCore` builds the shared server context, host client wrappers, settings helpers, and runtime utilities consumed by room handlers.

## Purpose

`createCore(bb, db)` is the common dependency object for server modules. `server.ts` opens storage, calls it once, then composes room services and registers their tools and RPCs (`server.ts:54-60`; `src/rooms/core/server/core.ts:30-31`). The exported `ServerCore` type is inferred from the function's returned object (`src/rooms/core/server/core.ts:401-402`).

## How it works

1. It creates disposal state, registers a hook to mark the core disposed, wraps available logger methods with secret redaction on a best-effort basis, installs illegal-transition logging, mounts realtime/helper signals, and creates owner-ask support (`src/rooms/core/server/core.ts:31-47`). A frozen logger remains unchanged.
2. It creates the raw host client from `hostContract`, then builds an Env Catalog key reader. A fresh cached value is used for ten minutes; otherwise the reader calls Env Catalog, trims its value, treats absent plugin/value or rejection as no key, logs only a change in key presence, and caches the result (`src/rooms/core/server/core.ts:48-72`).
3. The endpoint resolver reads the global `jev.provider` setting and asks for that provider's key. If that provider is not TypeSafe and has no key, it checks the TypeSafe key and switches only when TypeSafe has one. It tracks/logs the effective provider and whether a key exists (`src/rooms/core/server/core.ts:73-87`). The Jev layer is installed with this resolver and the database, and its disposer is registered with BB (`src/rooms/core/server/core.ts:89-90`).
4. It creates deploy drain and host-job support, then wraps the raw host call. Each call inherits the active schedule signal only if the caller supplied none and enters deploy-drain tracking. The wrapper removes internal `job` and `jobKey` options before the host call (`src/rooms/core/server/core.ts:91-117`).
5. A direct Jev method call resolves endpoint credentials and adds `jevApiKey` and `jevProvider` only when a key exists. A host-job method uses `createHostJobs` unless `LANE_PILOT_HOST_JOBS=0`; `runSandboxedCommand` additionally requires `job:true` (`src/rooms/core/server/core.ts:109-117`).
5. It builds native installation support using BB's lifecycle capability. Its native host wrapper calls `nativeInstaller.ensure(hostId)` before `prepareNativeClaude`, then forwards the host request (`src/rooms/core/server/core.ts:122-134`).
6. It defines serialized KV operations that continue after a previous operation rejects, settings inheritance, and context helpers for bindings, workspace execution and run state. It returns those helpers with the SDK, database, host clients, secrets, realtime, owner ask, output guard and deploy drain (`src/rooms/core/server/core.ts:136-153`, `:155-217`, `:377-384`).

### Plugin factory

1. `plugin(bb)` opens the database, installs thread signals, builds the core, binds the tool locale, and creates the shared services bag (`server.ts:55-62`).
2. It constructs room services in dependency order, mounts lifecycle forwarding, registers RPC and world/canary/learning integrations, then registers tools, CLI, assets, anamnesis and the optional Lane worktree provider (`server.ts:63-110`).
3. It defines isolated scheduled sweeps and a background startup recovery service. Startup recovery resumes helper stages, restores breakers, records canary start, reconciles tasks, and then adopts waiting rules and recovers owner questions and browser checks (`server.ts:111-154`, `:155-214`).
4. Workflow schedule sync, run sweep, and schedule-board tick are registered after recovery (`server.ts:215-221`).

| Factory branch | Condition | Result or failure |
|---|---|---|
| Thread wakeups | BB accepts thread lifecycle subscriptions. | Events wake watchers; without support the watcher polling path remains (`server.ts:57-58`, `packages/thread-observe/src/signals.ts:84-99`). |
| Worktree provider | BB exposes the provider API. | Provider registers; otherwise no provider is registered and attempts use the existing worktree path (`server.ts:108-110`). |
| Clean prior drain | Startup recovery finds a clean drain snapshot. | Redundant startup run, worktree and parked-task scans are left to their periodic schedules (`server.ts:173-185`, `:198-201`). |
| Initialization and registration | A synchronous constructor or registration call throws. | `plugin` has no outer catch, so its factory promise rejects (`server.ts:55-110`). |
| Scheduled or recovery work | A sweep or startup step fails. | Scheduled callbacks log and settle their local error path; startup `step` logs a failure and proceeds to the next step (`server.ts:111-133`, `:163-166`, `:215-221`). |

| Branch | Condition | Result or failure |
|---|---|---|
| Jev credential lookup | Env Catalog returns a nonblank key, returns no value, or throws. | The trimmed catalog result is cached for ten minutes; missing values and lookup failures cache as undefined (`src/rooms/core/server/core.ts:55-69`). If the selected provider is not TypeSafe and has no key, core checks the TypeSafe key and switches the endpoint only when that key exists; otherwise the selected endpoint remains without a key (`src/rooms/core/server/core.ts:74-87`). |
| Background host job | Environment permits jobs and method is a job kind; sandboxed command additionally has `job:true`. | Job wrapper returns host result or rejects on job error, abort, disposal or timeout (`src/rooms/core/server/core.ts:114-117`, `packages/host-calls/src/host-jobs.ts:73-88`). |
| Native prepare | Method name is `prepareNativeClaude`. | Installer ensure runs first; ensure errors prevent the host call (`src/rooms/core/server/core.ts:129-133`). |
| Logger wrapping | Logger method exists and assignment is permitted. | Redaction wrapper is assigned; frozen logger assignment failure is swallowed (`src/rooms/core/server/core.ts:35-39`). |

## Business rules

The core host wrapper attaches the current schedule abort signal only if the call did not already supply one; it strips `job` and `jobKey` before invoking the BB host API (`src/rooms/core/server/core.ts:100-117`). Serialized KV uses the prior promise's fulfillment and rejection paths to start each next operation, and resets the chain to a fulfilled promise after either outcome (`src/rooms/core/server/core.ts:136-141`).

## Public API or commands

The returned object is the inferred `ServerCore` API. It groups BB and DB access; runtime state and disposal; realtime, owner asks, logging and secrets; host, native installer, deploy drain and Jev helpers; KV/settings helpers; writer binding and workspace/run helpers (`src/rooms/core/server/core.ts:401-402`). Handler registration consumes this object together with the separately composed `Services` interface, which includes the `HarnessApi` (`src/rooms/core/server/rpc.ts:28-51`, `src/rooms/core/server/services.ts:50-80`).

## Gotchas

- `createCore` does not catch general initialization failures from its constructors; only the logger assignment and Env Catalog read described above have local fallback handling (`src/rooms/core/server/core.ts:31-47`, `:55-70`).
- `LANE_PILOT_HOST_JOBS=0` is an execution-mode switch in the core wrapper, not a host procedure option; the option never reaches the host (`src/rooms/core/server/core.ts:109-117`).
- `nativeHost` only has the host method's minimal `{hostId}` options type; it does not expose the full host client's extra call options (`src/rooms/core/server/core.ts:129-134`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
