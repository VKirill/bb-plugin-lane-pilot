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
  - src/rooms/workflow/server/workflow.ts
  - server.ts
  - packages/workflow-engine/docs/overview.md
  - packages/workflow-engine/package.json
---

# Workflow engine integration

TL;DR: The root plugin room supplies Lane Pilot workflows, host executors, RPC, scheduling and UI integration; the `@lane-pilot/workflow-engine` package owns the engine internals.

The workflow room creates the engine and workflow services used by the plugin server (`src/rooms/workflow/server/index.ts:1-11`). Its server-facing integration includes the workflow service and trigger service mounted by the root plugin (`server.ts:42-45`).

The shared package owns definitions, validation, execution, journals and package APIs. Read the [workflow engine overview](../packages/workflow-engine/docs/overview.md) for its internal design and the [package data model](../packages/workflow-engine/docs/data-model.md) for its tables (`packages/workflow-engine/package.json:1-14`).
