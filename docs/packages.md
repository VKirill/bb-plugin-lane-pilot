---
title: Shared packages
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [packages, api, monorepo]
sources:
  - packages/contracts/src/index.ts
  - packages/council/src/index.ts
  - packages/handoff/src/index.ts
  - packages/host-calls/src/index.ts
  - packages/i18n/src/index.ts
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
  - server.ts
  - package.json
---

# Shared packages

TL;DR: Small workspaces hold reusable contracts and services shared by Lane Pilot rooms; UI kit, workflow engine, and world simulation document their own APIs in their workspace docs.

## Package contracts

| Package | Purpose and public surface | Used by |
|---|---|---|
| `@lane-pilot/contracts` | Shared Zod schemas and types for tasks, stage receipts, workflow views, install receipts, and host-job kinds (`packages/contracts/src/index.ts:1-2`). | Room contracts, writer, workflow, host-worker. |
| `@lane-pilot/council` | Council roles, run protocol, moderator, renderer and SQLite migrations (`packages/council/src/index.ts:1-2`). | Council room and storage migration assembly (`src/rooms/storage/database.ts:3-5`). |
| `@lane-pilot/handoff` | Handoff card contracts, state transitions, storage, message formatting, receipt parsing and capability registry (`packages/handoff/src/index.ts:1-2`). `handoffMessage` includes objective, acceptance lines, inputs, budget and a fenced receipt format (`packages/handoff/src/messages.ts:12-37`). | Relay and task handoff services. |
| `@lane-pilot/host-calls` | Host job client plus `runOnHost`, a typed `runCommand` wrapper that sends host id in both payload and options (`packages/host-calls/src/run-on-host.ts:8-31`). | Writer, verification, scheduling and host-worker rooms. |
| `@lane-pilot/i18n` | Locale selection, `t()` and translated dictionaries (`packages/i18n/src/index.ts:1`). | Room UI and plugin app. |
| `@lane-pilot/jev` | Typed Jev client, judgment registry, thresholds, batch runner and receipts; importing a judgment module registers it (`packages/jev/src/index.ts:1-9`, `packages/jev/src/run.ts:56-63`). | Core and judgment-owning rooms. See [Jev adapter](jev-adapter.md). |
| `@lane-pilot/kit` | Node helpers for hashing, redaction, process spawning, bounded reads and JSONC patching, with a browser-safe `owns-paths` subpath (`packages/kit/src/index.ts:1-9`, `packages/kit/package.json:1-15`). | Server rooms and selected UI modules. |
| `@lane-pilot/memory-core` | Project memory records, audiences, retrieval, budgets, file import/export and SQLite helpers (`packages/memory-core/src/index.ts:1-23`). | Memory, writer context and run-insights. |
| `@lane-pilot/models` | Provider/model catalog normalization, reasoning compatibility, presets and model pricing (`packages/models/src/index.ts:1-5`). | Native-agent, settings, Jev selection and usage rooms. |
| `@lane-pilot/pixel-world` | Three.js scene primitives, assets, people, vehicles, navigation and static mesh batching. `batchStatic` merges eligible static meshes by transparency and leaves excluded mesh classes out (`packages/pixel-world/src/batch.ts:45-104`). | World UI. |
| `@lane-pilot/resilience` | Provider/model circuit breaker and per-run token, time and attempt budgets (`packages/resilience/src/index.ts:1-25`). | Writer dispatch and stability. |
| `@lane-pilot/run-insights` | Acceptance statistics, failure triage, rule proposals, lesson sourcing and golden memory cases (`packages/run-insights/src/index.ts:1-2`). | Runs, learning, memory and self-repair rooms. |
| `@lane-pilot/settings-catalog` | Setting keys, defaults, UI catalog, provider pool parsing and bookkeeping path rules (`packages/settings-catalog/src/index.ts:1-5`). | Settings, writer and verification rooms. |
| `@lane-pilot/thread-observe` | BB thread signal subscription plus completion classification and waiting. `decideThreadCompletion` classifies fresh thread reads; events only wake the watcher (`packages/thread-observe/src/completion.ts:77-119`, `packages/thread-observe/src/signals.ts:3-7`). | Writer, relay and helper-thread watchers. |

## Purpose

The small packages provide reusable contracts and utilities to root rooms; the workspace boundary is enforced by import conventions and dependency checks (`server.ts:1-48`, `package.json:55-60`).

## How it works

1. A room imports a package by its `@lane-pilot/*` name through the package entry point (`packages/contracts/src/index.ts:1-2`, `packages/memory-core/src/index.ts:1-23`).
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

- [Lane Pilot overview](overview.md)
