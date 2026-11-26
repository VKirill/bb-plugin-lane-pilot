---
title: Shared packages
type: component
created: 2026-10-10
updated: 2026-11-26
status: active
confidence: medium
tags: [packages, api, monorepo]
sources:
  - packages/contracts/src/index.ts
  - packages/contracts/src/schemas.ts
  - packages/handoff/src/index.ts
  - packages/handoff/src/messages.ts
  - packages/host-calls/src/index.ts
  - packages/host-calls/src/run-on-host.ts
  - packages/i18n/src/index.ts
  - packages/i18n/src/i18n.ts
  - packages/kit/src/index.ts
  - packages/kit/package.json
  - packages/memory-core/src/index.ts
  - packages/memory-core/src/store.ts
  - packages/models/src/index.ts
  - packages/models/src/role-models.ts
  - packages/models/src/agent-model.ts
  - packages/models/src/model-profiles.ts
  - packages/resilience/src/index.ts
  - packages/settings-catalog/src/index.ts
  - packages/thread-observe/src/index.ts
  - packages/thread-observe/src/completion.ts
  - packages/thread-observe/src/signals.ts
  - packages/ui-kit/src/index.ts
  - packages/workflow-engine/src/index.ts
  - packages/workflow-engine/src/ui.ts
  - src/rooms/package.json
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/contracts/index.ts
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/contracts/rpc-ops.ts
  - src/rooms/contracts/rpc-shell.ts
  - src/rooms/memory/server/handlers/session-memory.ts
  - server.ts
  - package.json
---

# Shared packages

TL;DR: Small workspaces hold reusable contracts and services shared by Lane Pilot rooms; UI kit and workflow engine document their own APIs in their workspace docs.

## Package contracts

| Package | Purpose and public surface | Used by |
|---|---|---|
| `@lane-pilot/contracts` | Shared Zod schemas and types, including the versioned TaskV2 contract, stage receipts, `LP_EVENTS`, `GRAPH_CATEGORIES`, step facts, node forms, workflow views, and host-job kinds (`packages/contracts/src/index.ts`, `packages/contracts/src/events.ts`, `packages/contracts/src/graph-categories.ts`). | Room contracts, writer, workflow, host-worker. |
| `@lane-pilot/handoff` | Handoff card contracts, state transitions, storage, message formatting, receipt parsing and capability registry (`packages/handoff/src/index.ts`). See `handoffMessage` steps under [Package operation details](package-operations.md#handoffmessage). | Relay and task handoff services. |
| `@lane-pilot/host-calls` | Host job client plus `runOnHost`, a typed `runCommand` wrapper. See timeout selection, forwarded fields and rejection behavior under [Package operation details](package-operations.md#runonhost). | Writer, verification, scheduling and host-worker rooms. |
| `@lane-pilot/i18n` | Locale selection, `t()`, role display names (`packages/i18n/src/role-names.ts`), and typed English and Russian dictionaries (`packages/i18n/src/index.ts`). | Room UI and plugin app. |
| `@lane-pilot/kit` | Node helpers for hashing, redaction, process spawning, bounded reads and JSONC patching, with a browser-safe `owns-paths` subpath (`packages/kit/src/index.ts:1-9`, `packages/kit/package.json`). | Server rooms and selected UI modules. |
| `@lane-pilot/memory-core` | Project memory records, audiences, retrieval, budgets, conflict detection, file import/export and SQLite helpers (`packages/memory-core/src/index.ts`, `packages/memory-core/src/store.ts`). | Memory, writer context and memory-eval rooms. |
| `@lane-pilot/models` | Provider/model catalog normalization, reasoning compatibility, presets, model pricing, role→model table with pools (`packages/models/src/role-models.ts`), and writer profiles (`packages/models/src/model-profiles.ts`). | Native-agent, core spawn, settings, writer selection and usage rooms. |
| `@lane-pilot/resilience` | Provider/model circuit breaker and per-run token, time and attempt budgets (`packages/resilience/src/index.ts`). | Writer dispatch and stability. |
| `@lane-pilot/settings-catalog` | Setting keys, defaults, UI catalog, provider pool parsing and bookkeeping path rules (`packages/settings-catalog/src/index.ts`). | Settings, writer and verification rooms. |
| `@lane-pilot/thread-observe` | BB thread signal subscription plus completion classification and waiting. `decideThreadCompletion` classifies fresh thread reads; events only wake the watcher. A top-level `error` status includes a detected BB failure cause after `thread_status_error:` (`packages/thread-observe/src/completion.ts`, `packages/thread-observe/src/signals.ts`). | Writer, relay and helper-thread watchers. |
| `@lane-pilot/ui-kit` | Shared UI components and realtime channel (`packages/ui-kit/src/index.ts`). | Plugin UI tabs and screens. |
| `@lane-pilot/workflow-engine` | Workflow journal, graph compiler, node forms (`agent|plan|script`), single engine clock, durable event inbox, per-step facts, and `./ui` export (`packages/workflow-engine/src/index.ts`, `packages/workflow-engine/src/ui.ts`). | Workflow, writer, schedule and UI rooms. |

## Purpose

The small packages provide reusable contracts and utilities to root rooms; the workspace boundary is enforced by import conventions and dependency checks (`server.ts`, `package.json`).

## How it works

1. Room modules import package APIs by their workspace specifiers; for example, runs contracts import `@lane-pilot/contracts` and session memory imports `@lane-pilot/memory-core` (`src/rooms/contracts/rpc-runs.ts`, `src/rooms/memory/server/handlers/session-memory.ts`).
2. Each package exposes domain functions and types; the consuming room supplies BB, SQLite, or host dependencies where required (`packages/host-calls/src/run-on-host.ts:8-31`).
3. Rooms compose those exports into server RPCs, UI behavior, and scheduled work (`src/rooms/core/server/rpc.ts`, `src/rooms/migrations.ts`).

## Modes and package variants

| Variant | What differs | Failure or boundary |
|---|---|---|
| Node-oriented helpers | `@lane-pilot/kit` root includes Node-based helpers; `owns-paths` is a browser-safe subpath (`packages/kit/package.json`, `packages/kit/src/index.ts:1-9`). | UI code that reaches Node imports cannot use the root entry. |
| Server and UI package entries | UI kit exposes its component entry and a realtime-channel subpath, while workflow engine exposes a separate `./ui` entry (`packages/ui-kit/src/index.ts`, `packages/workflow-engine/src/ui.ts`). See the [UI kit overview](../packages/ui-kit/docs/overview.md) and [workflow engine overview](../packages/workflow-engine/docs/overview.md). | Workspace-specific APIs and gotchas are owned by those linked docs. |
| Domain package with database migrations | `handoff`, `memory-core`, and `workflow-engine` export migrations consumed by the root storage migration list (`src/rooms/migrations.ts:4-21`). | Migration ownership stays with the package that defines each table. |

## Business rules

- Packages do not import from `src/`; rooms enter other rooms through public `index.ts` boundaries (`src/rooms/core/server/core.ts`).
- Domain packages expose public APIs from each package's index (`packages/<name>/src/index.ts`); a symbol is usable outside the package only when that entry exports it.

## Root RPC registration

See [RPC contract composition and route families](rpc-callers/contract-map.md) for `rpcContract` composition, and [rpcOps handlers](rpc-callers.md#rpcops-handlers) for its route schemas and branches (`src/rooms/contracts/index.ts`, `src/rooms/contracts/rpc-ops.ts`).

## Package operations

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

1. `decideThreadCompletion` turns top-level `error` status into an error decision whose detail includes the latest request's detected failure cause when present; with no detected cause the detail stays `thread_status_error`. Otherwise it filters malformed events and sub-agent events, retaining valid sequenced thread turn events (`packages/thread-observe/src/completion.ts`).
2. For a follow-up with `requestedAfter`, it finds the newest request. A missing/old request is incomplete; if no new turn start exists, an accepted input plus a later completion can finish the follow-up, otherwise failure evidence is checked and the decision remains incomplete.
3. For the current spawned turn, it orders valid events, selects the latest start and matches completion by request id when available. A completed status succeeds; failed, interrupted or error statuses are canceled; missing start, completion, status, or an unrecognized status remains incomplete.
4. If the turn is incomplete, detected provider/system errors, interrupted threads, rejected requests, failed provisioning, or a request with no session past the start limit become an error decision; otherwise the result includes thread status, queued-work state and turn detail.

| Decision | Condition | Outcome |
|---|---|---|
| Completed | Matching completion status is `completed`. | `{ok:true, via:"turn_completed"}`. |
| Canceled | Matching completion status is `failed`, `interrupted`, or `error`. | `{ok:false, via:"canceled"}` with turn detail. |
| Error | Thread status is `error` or incomplete turn evidence contains a detected thread failure. | `{ok:false, via:"error"}` with failure detail. |
| Incomplete | Request or turn evidence is absent, malformed, or has an unrecognized state without detected failure. | `{ok:false, via:"incomplete"}` with a diagnostic detail. |

## Public API or commands

The first table is the package API index; its source links point to entry modules. The [UI kit](../packages/ui-kit/docs/overview.md) and [workflow engine](../packages/workflow-engine/docs/overview.md) pages own their own API details.

## Gotchas

The UI bundle cannot import Node modules, and the package boundary is enforced by dependency rules (`packages/kit/src/index.ts:1-9`, `src/rooms/package.json`). Consult the package-owned pages before changing their internals.

## Workspace-owned references

- [UI kit overview](../packages/ui-kit/docs/overview.md)
- [Workflow engine overview](../packages/workflow-engine/docs/overview.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot architecture](architecture.md)
- [Repository conventions and boundaries](conventions.md)
- [Lane Pilot overview](overview.md)
- [Package operation details](package-operations.md)
