---
title: Shared packages
type: component
created: 2026-10-10
updated: 2026-10-20
status: active
confidence: medium
tags: [packages, api, monorepo]
sources:
  - packages/contracts/src/index.ts
  - packages/contracts/src/schemas.ts
  - packages/harness-core/src/index.ts
  - packages/harness-core/src/tree.ts
  - packages/harness-core/src/trajectory.ts
  - packages/harness-core/src/experience.ts
  - src/rooms/harness/server/harness.ts
  - src/rooms/harness/migrations.ts
  - packages/council/src/index.ts
  - packages/handoff/src/index.ts
  - packages/host-calls/src/index.ts
  - packages/i18n/src/index.ts
  - packages/i18n/src/i18n.ts
  - packages/i18n/src/i18n-board.ts
  - packages/jev/src/index.ts
  - packages/jev/src/registry.ts
  - packages/jev/src/judgments/output-guard.ts
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
  - packages/jev/src/client.ts
  - packages/jev/src/registry.ts
  - packages/jev/src/thresholds.ts
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
  - src/rooms/contracts/rpc-ops.ts
  - src/rooms/memory/server/session-memory.ts
  - server.ts
  - package.json
  - src/rooms/contracts/rpc-shell.ts
---

# Shared packages

TL;DR: Small workspaces hold reusable contracts and services shared by Lane Pilot rooms; UI kit, workflow engine, and world simulation document their own APIs in their workspace docs.

## Package contracts

| Package | Purpose and public surface | Used by |
|---|---|---|
| `@lane-pilot/contracts` | Shared Zod schemas and types, including the versioned TaskV2 contract and its work-kind values, stage receipts, workflow views, install receipts, and host-job kinds (`packages/contracts/src/index.ts:1-2`, `packages/contracts/src/schemas.ts:65-114`, `:131-139`). | Room contracts, writer, workflow, host-worker. |
| `@lane-pilot/council` | Council roles, run protocol, moderator, renderer and SQLite migrations (`packages/council/src/index.ts:1-2`). | Council room and storage migration assembly (`src/rooms/storage/database.ts:3-5`). |
| `@lane-pilot/handoff` | Handoff card contracts, state transitions, storage, message formatting, receipt parsing and capability registry (`packages/handoff/src/index.ts:1-2`). `handoffMessage` includes objective, acceptance lines, inputs, budget and a fenced receipt format (`packages/handoff/src/messages.ts:12-37`). | Relay and task handoff services. |
| `@lane-pilot/harness-core` | Writer-harness tree validation, fingerprinting and diff summaries; writer-event trajectory rendering; editor prompt construction; and parsing/rendering of edit verdicts and transferable experience (`packages/harness-core/src/index.ts:1-14`). | Harness server uses it to validate candidate trees, render attempt evidence and parse editor/reflection replies; writer attempts receive its materialized tree through the harness room (`src/rooms/harness/server/harness.ts:1-8`, `:211-250`, `:281-313`). See [writer harness](harness.md) for the end-to-end capability. |
| `@lane-pilot/host-calls` | Host job client plus `runOnHost`, a typed `runCommand` wrapper that sends host id in both payload and options (`packages/host-calls/src/run-on-host.ts:8-31`). | Writer, verification, scheduling and host-worker rooms. |
| `@lane-pilot/i18n` | Locale selection, `t()`, and typed English and Russian dictionaries, including Harness model and role labels (`packages/i18n/src/i18n.ts:325-339`, `:1382-1396`, `:2129-2134`) and Tasks board strings (`packages/i18n/src/i18n-board.ts:1-4`). | Room UI and plugin app. |
| `@lane-pilot/jev` | See the ordered `createJev` execution steps, modes and failures under [Package operations](#package-operations). Judgment definitions register themselves through `defineJudgment` when their own modules evaluate; the package root entry only re-exports shared APIs (`packages/jev/src/registry.ts:41-48`, `packages/jev/src/judgments/output-guard.ts:22-28`, `packages/jev/src/index.ts:1-9`). | Core and judgment-owning rooms. See [Jev adapter](jev-adapter.md) and [Jev run details](package-operations.md#jev-run). |
| `@lane-pilot/kit` | Node helpers for hashing, redaction, process spawning, bounded reads and JSONC patching, with a browser-safe `owns-paths` subpath (`packages/kit/src/index.ts:1-9`, `packages/kit/package.json:1-15`). | Server rooms and selected UI modules. |
| `@lane-pilot/memory-core` | Project memory records, audiences, retrieval, budgets, file import/export and SQLite helpers (`packages/memory-core/src/index.ts:1-23`). | Memory, writer context and run-insights. |
| `@lane-pilot/models` | Provider/model catalog normalization, reasoning compatibility, presets and model pricing (`packages/models/src/index.ts:1-5`). | Native-agent, settings, Jev selection and usage rooms. |
| `@lane-pilot/pixel-world` | Three.js scene primitives, assets, people, vehicles, navigation and static mesh batching. See ordered `batchStatic` and `createNavGrid` steps, branch outcomes and failures under [Package operations](#package-operations). | World UI. |
| `@lane-pilot/resilience` | Provider/model circuit breaker and per-run token, time and attempt budgets (`packages/resilience/src/index.ts:1-25`). | Writer dispatch and stability. |
| `@lane-pilot/run-insights` | Acceptance statistics, failure triage, rule proposals with writer/PM audience and always-on options, typed lesson forms, lesson sourcing and golden memory cases (`packages/run-insights/src/index.ts:1-2`, `:11-42`). | Runs, learning, memory and self-repair rooms. |
| `@lane-pilot/settings-catalog` | Setting keys, defaults, UI catalog, provider pool parsing and bookkeeping path rules (`packages/settings-catalog/src/index.ts:1-5`). | Settings, writer and verification rooms. |
| `@lane-pilot/thread-observe` | BB thread signal subscription plus completion classification and waiting. `decideThreadCompletion` classifies fresh thread reads; events only wake the watcher. A top-level `error` status includes a detected BB failure cause after `thread_status_error:` in the decision detail (`packages/thread-observe/src/completion.ts:77-90`, `:150-178`, `packages/thread-observe/src/signals.ts:3-7`). | Writer, relay and helper-thread watchers. |

## Purpose

The small packages provide reusable contracts and utilities to root rooms; the workspace boundary is enforced by import conventions and dependency checks (`server.ts:1-48`, `package.json:55-60`).

## How it works

1. Room modules import package APIs by their workspace specifiers; for example, the runs contract imports `@lane-pilot/contracts` and session memory imports `@lane-pilot/memory-core` (`src/rooms/contracts/rpc-runs.ts:1-2`, `src/rooms/memory/server/session-memory.ts:1-10`).
2. The package exposes domain functions and types; the consuming room supplies BB, SQLite, or host dependencies where required (`packages/jev/src/run.ts:56-63`, `packages/host-calls/src/run-on-host.ts:8-31`). Harness-core itself is pure parsing, rendering and tree logic; `src/rooms/harness` owns host, thread, KV and SQLite effects (`packages/harness-core/src/index.ts:1-14`, `src/rooms/harness/server/harness.ts:161-179`, `:211-250`).
3. The room composes those exports into server RPCs, UI behavior, and scheduled work (`src/rooms/core/server/rpc.ts:26-50`, `src/rooms/storage/database.ts:230-333`).

## Modes and package variants

| Variant | What differs | Failure or boundary |
|---|---|---|
| Node-oriented helpers | `@lane-pilot/kit` root includes Node-based helpers; `owns-paths` is a browser-safe subpath (`packages/kit/package.json:1-15`, `packages/kit/src/index.ts:1-9`). | UI code that reaches Node imports cannot use the root entry. |
| Judgment registration | Each judgment module calls `defineJudgment`; the registry stores it by id and rejects a different judgment with the same id (`packages/jev/src/registry.ts:41-48`, `packages/jev/src/judgments/output-guard.ts:22-28`). | A judgment is absent from the registry until its defining module is imported; the package root does not import the judgment catalog (`packages/jev/src/index.ts:1-9`). |
| Server and UI package entries | UI kit exposes its component entry and a realtime-channel subpath, while workflow engine exposes a separate `./ui` entry (`packages/ui-kit/package.json:14-17`, `packages/ui-kit/src/index.ts:1-32`, `packages/workflow-engine/package.json:7-13`, `packages/workflow-engine/src/ui.ts:1-4`). See the [UI kit overview](../packages/ui-kit/docs/overview.md) and [workflow engine overview](../packages/workflow-engine/docs/overview.md) for package-owned details. | Workspace-specific APIs and gotchas are owned by those linked docs. |
| Domain package with database migrations | Council, handoff, Jev, and run-insights export migrations consumed by the root storage migration list (`packages/council/src/index.ts:19-30`, `packages/handoff/src/index.ts:21-38`, `src/rooms/storage/database.ts:230-333`). | Migration ownership stays with the package that defines each table. |

## Business rules

- Packages do not import from `src/`; rooms enter other rooms through public indices (`package.json:55-60`, `src/rooms/core/server/services.ts:1-20`).
- Domain packages expose public APIs from `src/index.ts`; a name is usable outside the package only when that entry exports it (`packages/council/src/index.ts:1-32`, `packages/handoff/src/index.ts:1-48`).

## Root RPC registration

See [RPC contract composition and route families](rpc-callers/contract-map.md) for how `rpcContract`, `rpcShell`, and `rpcOps` compose, validate and report their outcomes (`src/rooms/contracts/index.ts:17-26`, `src/rooms/contracts/rpc-shell.ts:1-109`, `src/rooms/contracts/rpc-ops.ts:5-64`).

## Package operations

### `createJev`

1. For each judgment, it redacts built state, gets questions, resolves mode and thresholds, and throws if the judgment exceeds the 48-question cap (`packages/jev/src/run.ts:59-64`, `packages/jev/src/registry.ts:11-12`, `packages/jev/src/thresholds.ts:42-46`).
2. It skips receipt writes without a database or in off mode; otherwise it records call, decision and usage details, with insert errors logged and converted to a null receipt id (`packages/jev/src/run.ts:66-80`).
3. It returns fallback for off mode; batches other entries that share model and serialized state, splitting when a batch would exceed the question count or the serialized-question character bound; then sends namespaced questions to the client with the maximum member timeout and shared budget/signal (`packages/jev/src/run.ts:99-129`, `packages/jev/src/client.ts:21-24`).
4. A failed call, missing answers, or thrown decision function returns fallback; shadow mode returns fallback plus the shadow decision; an escalation decision returns its target; otherwise the Jev decision and answers are returned (`packages/jev/src/run.ts:82-97`).

| Mode or failure | Outcome |
|---|---|
| `off` / `shadow` / `active` | Off calls no client and returns fallback; shadow calls Jev but keeps fallback as the decision; active uses the Jev decision or declared escalation (`packages/jev/src/run.ts:94-105`, `packages/jev/src/registry.ts:12`). |
| Preparation or rejected client promise | Question overflow throws before execution; rejected `client.call` rejects the batch promise (`packages/jev/src/run.ts:59-64`, `:118-129`). |
| Jev call or decision failure | Returns deterministic judgment fallback, with failure status recorded when a database is available (`packages/jev/src/run.ts:82-92`). |

### `batchStatic`

1. It updates world transforms, creates shared opaque/glass materials, and walks visible descendants. `noBatch` skips a node and its descendants; `isolate` starts a separate target (`packages/pixel-world/src/batch.ts:45-65`).
2. It accepts only visible static single-material toon meshes without textures, glow, vertex colors or children; ineligible objects remain in the scene (`packages/pixel-world/src/batch.ts:27-35`).
3. It clones geometry, transforms it into target space, fixes mirrored winding, bakes color/alpha, detaches source meshes, then merges opaque and transparent groups separately (`packages/pixel-world/src/batch.ts:67-131`).
4. It returns created meshes, source counts, and a disposer for owned resources (`packages/pixel-world/src/batch.ts:48-52`, `:134-137`). A null merge leaves already detached sources without a replacement; unexpected processing exceptions propagate (`packages/pixel-world/src/batch.ts:119-137`).

### `createNavGrid`

1. It captures bounds and obstacle rectangles, applies default step and margins, then indexes obstacles in spatial buckets (`packages/pixel-world/src/nav.ts:34-50`).
2. Point checks reject margin-adjusted out-of-bounds positions, then test nearby obstacle buckets; segment checks sample the line (`packages/pixel-world/src/nav.ts:53-75`).
3. `findPath` returns the exact target when its segment is clear. Otherwise it lazily caches blocked grid cells, snaps blocked endpoints toward a free cell within radius three, and runs eight-direction A* with diagonal corner checks and an 8,000-iteration cap (`packages/pixel-world/src/nav.ts:84-93`, `:107-180`).
4. A found route is converted to world points and smoothed by skipping visible waypoints. If no route is found, the API still returns a waypoint list ending at the requested target; it has no separate failure status (`packages/pixel-world/src/nav.ts:185-212`).

See [Package operation details](package-operations.md) for full limits, branch tables and gotchas.

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

1. `decideThreadCompletion` turns top-level `error` status into an error decision whose detail includes the latest request's detected failure cause when present; with no detected cause the detail stays `thread_status_error`. Otherwise it filters malformed events and sub-agent events, retaining valid sequenced thread turn events (`packages/thread-observe/src/completion.ts:30-53`, `:77-90`, `:150-178`).
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
- [Writer harness](harness.md)
- [Lane Pilot overview](overview.md)
- [Package operation details](package-operations.md)
