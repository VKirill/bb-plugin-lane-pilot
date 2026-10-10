---
title: Lane Pilot overview
type: overview
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [overview, bb-plugin, orchestration]
sources:
  - package.json
  - server.ts
  - src/rooms/core/server/core.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/native-agent/ui/composer-enable.tsx
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/writer/server/start.ts
  - src/rooms/writer/server/verify.ts
  - src/rooms/writer/server/finish.ts
  - src/rooms/storage/database.ts
  - src/rooms/schedule/scheduler.ts
  - src/rooms/anamnesis/collect.ts
  - src/rooms/council/ui/council-page.tsx
  - src/rooms/memory/server/memory.ts
  - src/rooms/core/server/lifecycle-events.ts
  - src/rooms/anamnesis/pii.ts
  - src/rooms/anamnesis/year-review.ts
  - src/rooms/memory/ui/memory-records.tsx
---

# Lane Pilot overview

TL;DR: Lane Pilot is a BB plugin that turns a project chat into an orchestration surface for isolated coding tasks, checks, reviews, and project maintenance.

## Product shape

The plugin is registered by BB from the `bb.server` entry in `package.json`; the entry opens plugin storage, builds a shared server core, mounts room services, then registers RPC and tools (`package.json:8-18`, `server.ts:55-107`). The plugin UI is a separate `bb.app` entry (`package.json:8-18`).

A user enables Lane Pilot for a new project chat through the composer. The UI gets activation context, requires a selected project and a resolvable writer binding, then sets a dispatch token and native agent selection (`src/rooms/native-agent/ui/composer-enable.tsx:49-60`, `:71-94`, `:96-123`).

The PM sends work through Lane Pilot tools. The writer dispatcher resolves task ownership and starts writer attempts; attempts use an isolated workspace, then verification and finish stages produce receipts and merge accepted work (`src/rooms/writer/server/dispatch.ts:1-80`, `src/rooms/writer/server/start.ts:1-80`, `src/rooms/writer/server/verify.ts:1-80`, `src/rooms/writer/server/finish.ts:1-80`).

## Main areas

- **Project orchestration:** runs, tasks, attempts, stage receipts, checks, and merge coordination are stored in plugin SQLite (`src/rooms/storage/database.ts:30-70`, `:128-156`). See [architecture](architecture.md) and [data model](data-model.md).
- **Settings and integrations:** typed RPC endpoints expose project settings, provider selection, workflows, schedules, council, memory, and knowledge to the UI (`src/rooms/core/server/rpc.ts:26-50`). The surface is declared in [RPC contracts](rpc-callers.md).
- **Project knowledge:** memory RPCs create and retrieve project-scoped agent records; the UI displays the records and their lifecycle (`src/rooms/memory/server/memory.ts:19-78`, `src/rooms/memory/ui/memory-records.tsx:13-64`).
- **Owner profile:** Anamnesis collects enabled sources, masks detected personal data, stores evidence-backed records, and can render an annual review (`src/rooms/anamnesis/collect.ts:29-63`, `src/rooms/anamnesis/pii.ts:41-72`, `src/rooms/anamnesis/year-review.ts:13-72`).
- **Council and world view:** `CouncilPage` renders the council session UI, and the optional Pixel World service is mounted with the plugin (`src/rooms/council/ui/council-page.tsx:65-124`, `server.ts:97-105`).

## Workspaces

The root workspace contains BB-facing rooms and small shared packages. `@lane-pilot/ui-kit`, `@lane-pilot/workflow-engine`, and `@lane-pilot/world-sim` own their internal documentation; this page links to their overviews instead of restating internals ([UI kit overview](../packages/ui-kit/docs/overview.md), [workflow engine overview](../packages/workflow-engine/docs/overview.md), [world simulation overview](../packages/world-sim/docs/overview.md)). The remaining small packages are described in [packages](packages.md).

## System references

- [Architecture](architecture.md) — runtime composition and dependency boundaries.
- [Deployment](deployment.md) — build, configuration, run, and deploy inputs.
- [Gotchas](gotchas.md) — cross-cutting behavior and failure boundaries.
- [Data model](data-model.md) — core entity map and domain-owned table references.
- [Jev adapter](jev-adapter.md) — native writer reasoning selection.
