---
title: Shared packages
type: component
created: 2026-10-10
updated: 2026-10-14
status: active
confidence: medium
tags: [packages, api, monorepo]
sources:
  - packages/contracts/src/index.ts
  - packages/contracts/src/schemas.ts
  - packages/council/src/index.ts
  - packages/handoff/src/index.ts
  - packages/host-calls/src/index.ts
  - packages/i18n/src/index.ts
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/i18n-board.ts
  - packages/jev/src/index.ts
  - packages/kit/src/index.ts
  - packages/memory-core/src/index.ts
  - packages/models/src/index.ts
  - packages/pixel-world/src/index.ts
  - packages/resilience/src/index.ts
  - packages/run-insights/src/index.ts
  - packages/settings-catalog/src/index.ts
  - packages/thread-observe/src/index.ts
  - packages/thread-observe/src/completion.ts
  - packages/pixel-world/src/batch.ts
  - packages/pixel-world/src/nav.ts
  - packages/handoff/src/messages.ts
  - packages/host-calls/src/run-on-host.ts
  - packages/jev/src/run.ts
  - packages/kit/package.json
  - packages/thread-observe/src/signals.ts
  - src/rooms/storage/database.ts
  - packages/ui-kit/src/index.ts
  - packages/ui-kit/package.json
  - packages/workflow-engine/src/index.ts
  - packages/workflow-engine/src/ui.ts
  - packages/workflow-engine/package.json
  - packages/world-sim/docs/overview.md
  - src/rooms/package.json
  - src/rooms/core/server/services.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/contracts/index.ts
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/memory/server/session-memory.ts
  - server.ts
  - package.json
---

# Shared packages

TL;DR: Small workspaces hold reusable contracts and services shared by Lane Pilot rooms; UI kit, workflow engine, and world simulation document their own APIs in their workspace docs.

## Package contracts

| Package | Purpose and public surface | Used by |
|---|---|---|
| `@lane-pilot/contracts` | Shared Zod schemas and types, including the versioned TaskV2 contract and its work-kind values, stage receipts, workflow views, install receipts, and host-job kinds (`packages/contracts/src/index.ts:1-2`, `packages/contracts/src/schemas.ts:65-114`, `:131-139`). | Room contracts, writer, workflow, host-worker. |
| `@lane-pilot/council` | Council roles, run protocol, moderator, renderer and SQLite migrations (`packages/council/src/index.ts:1-2`). | Council room and storage migration assembly (`src/rooms/storage/database.ts:3-5`). |
| `@lane-pilot/handoff` | Handoff card contracts, state transitions, storage, message formatting, receipt parsing and capability registry (`packages/handoff/src/index.ts:1-2`). `handoffMessage` includes objective, acceptance lines, inputs, budget and a fenced receipt format (`packages/handoff/src/messages.ts:12-37`). | Relay and task handoff services. |
| `@lane-pilot/host-calls` | Host job client plus `runOnHost`, a typed `runCommand` wrapper that sends host id in both payload and options (`packages/host-calls/src/run-on-host.ts:8-31`). | Writer, verification, scheduling and host-worker rooms. |
| `@lane-pilot/i18n` | Locale selection, `t()`, and typed English and Russian dictionaries, including the Tasks board strings (`packages/i18n/src/i18n.ts:2047-2052`, `:2064-2079`, `:2117-2119`, `packages/i18n/src/i18n-board.ts:1-4`). | Room UI and plugin app. |
| `@lane-pilot/jev` | Typed Jev client, judgment registry, thresholds, batch runner and receipts; importing a judgment module registers it (`packages/jev/src/index.ts:1-9`, `packages/jev/src/run.ts:56-63`). | Core and judgment-owning rooms. See [Jev adapter](jev-adapter.md). |
| `@lane-pilot/kit` | Node helpers for hashing, redaction, process spawning, bounded reads and JSONC patching, with a browser-safe `owns-paths` subpath (`packages/kit/src/index.ts:1-9`, `packages/kit/package.json:1-15`). | Server rooms and selected UI modules. |
| `@lane-pilot/memory-core` | Project memory records, audiences, retrieval, budgets, file import/export and SQLite helpers (`packages/memory-core/src/index.ts:1-23`). | Memory, writer context and run-insights. |
| `@lane-pilot/models` | Provider/model catalog normalization, reasoning compatibility, presets and model pricing (`packages/models/src/index.ts:1-5`). | Native-agent, settings, Jev selection and usage rooms. |
| `@lane-pilot/pixel-world` | Three.js scene primitives, assets, people, vehicles, navigation and static mesh batching. `batchStatic` merges eligible static meshes by transparency and leaves excluded mesh classes out (`packages/pixel-world/src/batch.ts:45-104`). The root entry exports `createNavGrid` for obstacle-aware point checks and pathfinding (`packages/pixel-world/src/index.ts:1-8`, `packages/pixel-world/src/nav.ts:34-38`). | World UI. |
| `@lane-pilot/resilience` | Provider/model circuit breaker and per-run token, time and attempt budgets (`packages/resilience/src/index.ts:1-25`). | Writer dispatch and stability. |
| `@lane-pilot/run-insights` | Acceptance statistics, failure triage, rule proposals, lesson sourcing and golden memory cases (`packages/run-insights/src/index.ts:1-2`). | Runs, learning, memory and self-repair rooms. |
| `@lane-pilot/settings-catalog` | Setting keys, defaults, UI catalog, provider pool parsing and bookkeeping path rules (`packages/settings-catalog/src/index.ts:1-5`). | Settings, writer and verification rooms. |
| `@lane-pilot/thread-observe` | BB thread signal subscription plus completion classification and waiting. `decideThreadCompletion` classifies fresh thread reads; events only wake the watcher (`packages/thread-observe/src/completion.ts:77-119`, `packages/thread-observe/src/signals.ts:3-7`). | Writer, relay and helper-thread watchers. |

## Purpose

The small packages provide reusable contracts and utilities to root rooms; the workspace boundary is enforced by import conventions and dependency checks (`server.ts:1-48`, `package.json:55-60`).

## How it works

1. Room modules import package APIs by their workspace specifiers; for example, the runs contract imports `@lane-pilot/contracts` and session memory imports `@lane-pilot/memory-core` (`src/rooms/contracts/rpc-runs.ts:1-2`, `src/rooms/memory/server/session-memory.ts:1-10`).
2. The package exposes domain functions and types; the consuming room supplies BB, SQLite, or host dependencies where required (`packages/jev/src/run.ts:56-63`, `packages/host-calls/src/run-on-host.ts:8-31`).
3. The room composes those exports into server RPCs, UI behavior, and scheduled work (`src/rooms/core/server/rpc.ts:26-50`, `src/rooms/storage/database.ts:230-320`).

## Modes and package variants

| Variant | What differs | Failure or boundary |
|---|---|---|
| Node-oriented helpers | `@lane-pilot/kit` root includes Node-based helpers; `owns-paths` is a browser-safe subpath (`packages/kit/package.json:1-15`, `packages/kit/src/index.ts:1-9`). | UI code that reaches Node imports cannot use the root entry. |
| Side-effect registration | Jev judgment modules register when imported; the plugin's room metadata lists side-effect files (`packages/jev/src/run.ts:56-63`, `src/rooms/package.json:1-14`). | A tree-shaken or omitted side-effect import leaves that judgment unregistered. |
| Server and UI package entries | UI kit exposes its component entry and a realtime-channel subpath, while workflow engine exposes a separate `./ui` entry (`packages/ui-kit/package.json:14-17`, `packages/ui-kit/src/index.ts:1-32`, `packages/workflow-engine/package.json:7-13`, `packages/workflow-engine/src/ui.ts:1-4`). See the [UI kit overview](../packages/ui-kit/docs/overview.md) and [workflow engine overview](../packages/workflow-engine/docs/overview.md) for package-owned details. | Workspace-specific APIs and gotchas are owned by those linked docs. |
| Domain package with database migrations | Council, handoff, Jev, and run-insights export migrations consumed by the root storage migration list (`packages/council/src/index.ts:19-30`, `packages/handoff/src/index.ts:21-38`, `src/rooms/storage/database.ts:230-320`). | Migration ownership stays with the package that defines each table. |

## Business rules

- Packages do not import from `src/`; rooms enter other rooms through public indices (`package.json:55-60`, `src/rooms/core/server/services.ts:1-20`).
- Domain packages expose public APIs from `src/index.ts`; a name is usable outside the package only when that entry exports it (`packages/council/src/index.ts:1-32`, `packages/handoff/src/index.ts:1-48`).

## Root RPC registration

1. `registerRpc(ctx, services)` builds the RPC handler map by calling each room factory with its declared dependencies. Most factories receive both values; stack, token usage, secrets, Jev provider, workspace provider, and self-repair receive only `ctx`; council receives `ctx.db` and its service; canary and world receive their service (`src/rooms/core/server/rpc.ts:27-50`).
2. It spreads the returned maps into one object, passes the object and a debug logger callback to `timeRpcHandlers`, then registers the wrapped handlers against `rpcContract` (`src/rooms/core/server/rpc.ts:29-51`).
3. Registration happens once per call to `registerRpc`; the function returns the result of `ctx.bb.rpc.register` and does not catch a registration rejection (`src/rooms/core/server/rpc.ts:27-51`).

| Branch | Dependency and outcome | Failure behavior |
|---|---|---|
| Standard room factory | Receives `ctx` and `services`, then returns a map keyed by its contract methods. | A factory exception aborts map construction before registration. |
| Narrow dependency factory | Receives `ctx`, `ctx.db` plus council service, or a single service as listed above. | Missing dependencies or factory errors propagate; there is no local recovery branch. |
| Timed registration | Every assembled handler is timed before `ctx.bb.rpc.register` receives it. | Handler rejection propagates after timing logs; logging and serialization failures are swallowed by the timing wrapper (`src/rooms/core/server/rpc-timing.ts:12-40`). |

The contract and handlers are separate inputs: `rpcContract` supplies method validation, while the composed map supplies implementations (`src/rooms/contracts/index.ts:17-26`, `src/rooms/core/server/rpc.ts:27-51`).

## Package operations

Pixel-world batching and navigation internals, including their branch and failure behavior, are documented in [Package operations](package-operations.md).

### Host command wrapper

1. `runOnHost(host, args)` accepts host id, working directory, command and command timeout, with an optional transport timeout (`packages/host-calls/src/run-on-host.ts:17-24`).
2. It calls `runCommand` with the host id in both the request and call options, forwarding command, cwd and command timeout (`packages/host-calls/src/run-on-host.ts:26-31`).
3. An explicit transport timeout is forwarded; otherwise it uses the command timeout plus five seconds in milliseconds. The host result promise is returned directly (`packages/host-calls/src/run-on-host.ts:26-31`).

| Branch | Result or failure |
|---|---|
| Explicit `timeoutMs` | The caller's transport deadline is used. |
| Omitted `timeoutMs` | Transport deadline is `(timeoutSec + 5) * 1000`. |
| Host call rejects | The rejection propagates; the wrapper does not catch or translate it. |

### Handoff message formatting

1. `handoffMessage(card)` formats identity/title, objective, numbered acceptance criteria, inputs, budget, and a fixed fenced JSON receipt instruction in that order (`packages/handoff/src/messages.ts:12-37`).
2. Empty inputs render as `- none`; budget includes each truthy minutes, turns, token, and deadline field, or `none stated` if no budget fields are present (`packages/handoff/src/messages.ts:3-10`, `:13-29`).
3. `extractHandoffReceiptBlock(output, handoffId)` scans fenced JSON blocks from newest to oldest, skips malformed JSON, returns the matching receipt without its `handoff` property, and returns `null` when none matches (`packages/handoff/src/messages.ts:40-55`).

The formatter returns a string and declares no error result; JSON parse failures are handled only by receipt extraction, where they skip that block (`packages/handoff/src/messages.ts:12-16`, `:40-55`).

### Thread completion decision

1. `decideThreadCompletion` first turns top-level `error` status into an error decision. Otherwise it filters malformed events and sub-agent events, retaining valid sequenced thread turn events (`packages/thread-observe/src/completion.ts:30-53`, `:77-86`).
2. For a follow-up with `requestedAfter`, it finds the newest request. A missing/old request is incomplete; if no new turn start exists, an accepted input plus a later completion can finish the follow-up, otherwise failure evidence is checked and the decision remains incomplete (`packages/thread-observe/src/completion.ts:87-105`).
3. For the current spawned turn, it orders valid events, selects the latest start and matches completion by request id when available. A completed status succeeds; failed, interrupted or error statuses are canceled; missing start, completion, status, or an unrecognized status remains incomplete (`packages/thread-observe/src/completion.ts:55-75`).
4. If the turn is incomplete, detected provider/system errors, interrupted threads, rejected requests, failed provisioning, or a request with no session past the start limit become an error decision; otherwise the result includes thread status, queued-work state and turn detail (`packages/thread-observe/src/completion.ts:107-116`, `:145-173`).

| Decision | Condition | Outcome |
|---|---|---|
| Completed | Matching completion status is `completed`. | `{ok:true, via:"turn_completed"}`. |
| Canceled | Matching completion status is `failed`, `interrupted`, or `error`. | `{ok:false, via:"canceled"}` with turn detail. |
| Error | Thread status is `error` or incomplete turn evidence contains a detected thread failure. | `{ok:false, via:"error"}` with failure detail. |
| Incomplete | Request or turn evidence is absent, malformed, or has an unrecognized state without detected failure. | `{ok:false, via:"incomplete"}` with a diagnostic detail. |

## Public API or commands

The first table is the package API index; its package rows link to entry modules. The [UI kit](../packages/ui-kit/docs/overview.md), [workflow engine](../packages/workflow-engine/docs/overview.md), and [world simulation](../packages/world-sim/docs/overview.md) pages own their own API details.

## Gotchas

The Jev package registers judgments on import, the UI bundle cannot import Node modules, and the package boundary is enforced by dependency rules (`packages/jev/src/run.ts:56-63`, `packages/kit/src/index.ts:1-9`, `src/rooms/package.json:1-14`). Consult the package-owned pages before changing their internals.

## Workspace-owned references

- [UI kit overview](../packages/ui-kit/docs/overview.md)
- [Workflow engine overview](../packages/workflow-engine/docs/overview.md)
- [World simulation overview](../packages/world-sim/docs/overview.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot architecture](architecture.md)
- [Lane Pilot overview](overview.md)
- [Package operation details](package-operations.md)
