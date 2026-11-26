---
title: Workflow engine integration
type: overview
created: 2026-10-07
updated: 2026-10-10
status: active
confidence: low
tags: [workflow, integration, package]
sources:
  - src/rooms/workflow/server/index.ts
  - src/rooms/workflow/server/services/workflow.ts
  - server.ts
  - packages/workflow-engine/docs/overview.md
  - packages/workflow-engine/src/engine-clock.ts
  - packages/workflow-engine/src/inbox.ts
  - packages/workflow-engine/src/node-form.ts
  - packages/workflow-engine/src/run-facts.ts
  - packages/workflow-engine/package.json
---

# Workflow engine integration

TL;DR: The root plugin room supplies Lane Pilot workflows, host executors, RPC, scheduling, event inbox triggers, and UI integration; `@lane-pilot/workflow-engine` owns the journal, single clock, node forms, step facts, and engine internals.

The workflow room creates the engine and workflow services used by the plugin server (`src/rooms/workflow/server/index.ts`, `src/rooms/workflow/server/services/workflow.ts`). Its integration is mounted via the room registry in `server.ts`.

The shared package owns definitions, validation, execution, the single `engine-clock` timer (`packages/workflow-engine/src/engine-clock.ts`), durable `lane_pilot_wf_inbox` events (`packages/workflow-engine/src/inbox.ts`), node execution forms (`agent | plan | script`, `packages/workflow-engine/src/node-form.ts`), per-step facts (`packages/workflow-engine/src/run-facts.ts`), journals, and package APIs. Read the [workflow engine overview](../packages/workflow-engine/docs/overview.md) for its internal design and the [package data model](../packages/workflow-engine/docs/data-model.md) for its tables.
