---
title: Server core construction
type: component
created: 2026-10-16
updated: 2026-10-16
status: active
confidence: medium
tags: [server, core, host-calls]
sources:
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/services.ts
  - packages/host-calls/src/host-jobs.ts
  - server.ts
---

# Server core construction

TL;DR: `createCore` builds the shared server context, host client wrappers, settings helpers, and runtime utilities consumed by room handlers.

## Purpose

`createCore(bb, db)` is the common dependency object for server modules. `server.ts` opens storage, calls it once, then composes room services and registers their tools and RPCs (`server.ts:54-60`; `src/rooms/core/server/core.ts:30-31`). The exported `ServerCore` type is inferred from the function's returned object (`src/rooms/core/server/core.ts:381-384`).

## How it works

1. It creates disposal state, registers a hook to mark the core disposed, wraps available logger methods with secret redaction on a best-effort basis, installs illegal-transition logging, mounts realtime/helper signals, and creates owner-ask support (`src/rooms/core/server/core.ts:31-47`). A frozen logger remains unchanged.
2. It creates the raw host client from `hostContract`, then prepares a cached Jev endpoint. The selected provider key is read from Env Catalog, trimmed and cached for ten minutes; lookup failure becomes no key. If the chosen non-TypeSafe provider has no key, core tries the TypeSafe key (`src/rooms/core/server/core.ts:48-90`).
3. It creates deploy drain and wraps the raw host call. The wrapper supplies the active schedule signal when none was provided, removes internal job options, and places every request inside deploy-drain tracking (`src/rooms/core/server/core.ts:91-117`).
4. Before a direct Jev method call, it resolves provider credentials and adds them to the input only when a key is available. Calls that meet the host-job predicate go through `createHostJobs`; sandboxed commands require an explicit `job:true`, and `LANE_PILOT_HOST_JOBS=0` forces direct calls (`src/rooms/core/server/core.ts:50-53`, `:109-117`).
5. It builds native installation support using BB's lifecycle capability. Its native host wrapper calls `nativeInstaller.ensure(hostId)` before `prepareNativeClaude`, then forwards the host request (`src/rooms/core/server/core.ts:122-134`).
6. It defines serialized KV operations that continue after a previous operation rejects, settings inheritance, and context helpers for bindings, workspace execution and run state. It returns those helpers with the SDK, database, host clients, secrets, realtime, owner ask, output guard and deploy drain (`src/rooms/core/server/core.ts:136-153`, `:155-217`, `:377-384`).

| Branch | Condition | Result or failure |
|---|---|---|
| Jev credential lookup | Env Catalog returns a nonblank key, returns no value, or throws. | Trimmed key is cached; missing or failed lookup caches undefined. A missing key for a selected non-TypeSafe provider triggers a TypeSafe-key fallback (`src/rooms/core/server/core.ts:55-69`, `:74-87`). |
| Background host job | Environment permits jobs and method is a job kind; sandboxed command additionally has `job:true`. | Job wrapper returns host result or rejects on job error, abort, disposal or timeout (`src/rooms/core/server/core.ts:114-117`, `packages/host-calls/src/host-jobs.ts:73-88`). |
| Native prepare | Method name is `prepareNativeClaude`. | Installer ensure runs first; ensure errors prevent the host call (`src/rooms/core/server/core.ts:129-133`). |
| Logger wrapping | Logger method exists and assignment is permitted. | Redaction wrapper is assigned; frozen logger assignment failure is swallowed (`src/rooms/core/server/core.ts:35-39`). |

## Business rules

The core host wrapper attaches the current schedule abort signal only if the call did not already supply one; it strips `job` and `jobKey` before invoking the BB host API (`src/rooms/core/server/core.ts:100-117`). Serialized KV uses the prior promise's fulfillment and rejection paths to start each next operation, and resets the chain to a fulfilled promise after either outcome (`src/rooms/core/server/core.ts:136-141`).

## Public API or commands

The returned object is the inferred `ServerCore` API. It groups BB and DB access; runtime state and disposal; realtime, owner asks, logging and secrets; host, native installer, deploy drain and Jev helpers; KV/settings helpers; writer binding and workspace/run helpers (`src/rooms/core/server/core.ts:377-384`). Handler registration consumes this object together with the separately composed `Services` interface (`src/rooms/core/server/rpc.ts:27-50`, `src/rooms/core/server/services.ts:50-80`).

## Gotchas

- `createCore` does not catch general initialization failures from its constructors; only the logger assignment and Env Catalog read described above have local fallback handling (`src/rooms/core/server/core.ts:31-47`, `:55-70`).
- `LANE_PILOT_HOST_JOBS=0` is an execution-mode switch in the core wrapper, not a host procedure option; the option never reaches the host (`src/rooms/core/server/core.ts:109-117`).
- `nativeHost` only has the host method's minimal `{hostId}` options type; it does not expose the full host client's extra call options (`src/rooms/core/server/core.ts:129-134`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
