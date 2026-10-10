---
title: Workflow Engine — Overview
type: overview
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [workflow-engine, package, overview]
sources:
  - packages/workflow-engine/src/index.ts
  - packages/workflow-engine/src/catalog.ts
  - packages/workflow-engine/src/db.ts
  - packages/workflow-engine/src/draft-store.ts
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/files.ts
  - packages/workflow-engine/src/journal.ts
  - packages/workflow-engine/src/schema.ts
  - packages/workflow-engine/src/store.ts
  - packages/workflow-engine/package.json
  - packages/workflow-engine/src/ui.ts
  - src/rooms/workflow/index.ts
  - src/rooms/storage/database.ts
  - src/rooms/critique/critique.ts
  - src/rooms/schedule/time.ts
---
# Workflow Engine — Overview
TL;DR: `@lane-pilot/workflow-engine` defines, validates, routes, executes, and stores graph-based workflows for Lane Pilot’s host application.

## What it is

This private ESM package provides the workflow definition format, validation and lowering, expression evaluation, a resumable graph runner, a catalog and router, draft editing and test support, artifacts, and SQLite journal/store adapters. The package root export points at `src/index.ts`, which re-exports server modules including engine, file, and store code that import `node:` modules. The separate `./ui` export points at `src/ui.ts`, which re-exports cron, draft-view, edge-label, and view helpers (`packages/workflow-engine/package.json:8-14`, `packages/workflow-engine/src/index.ts:9-30`, `packages/workflow-engine/src/engine.ts:2`, `packages/workflow-engine/src/files.ts:1-3`, `packages/workflow-engine/src/store.ts:1-3`, `packages/workflow-engine/src/ui.ts:1-4`).

Built-in workflow definitions are supplied by the caller to the catalog; they are not stored in this package. Custom definitions load from global and project workflow directories through the file store (`packages/workflow-engine/src/catalog.ts:17-25`, `packages/workflow-engine/src/store.ts:24-26`).

## Stack

- TypeScript ESM package; package exports point directly at TypeScript source (`packages/workflow-engine/package.json:2-14`).
- SQLite access uses a `better-sqlite3` database handle (`packages/workflow-engine/src/db.ts:1-4`).
- Workflow schemas and domain validation use Zod (`packages/workflow-engine/src/schema.ts:1-2`).
- Package code imports `@lane-pilot/kit` for hashing and the host application supplies model and contract integrations (for example `packages/workflow-engine/src/journal.ts:1-4`, `packages/workflow-engine/src/store.ts:1-7`).

## How it starts or is used

1. The host passes built-in definitions and optional file sources to `createWorkflowCatalog`; it loads and validates those definitions into a `WorkflowStore` (`packages/workflow-engine/src/catalog.ts:17-25`, `packages/workflow-engine/src/store.ts:50-58`).
2. The host creates `WorkflowEngine` with a SQLite handle and `harnessVersion`, registers node executors, and starts validated workflows with inputs (`packages/workflow-engine/src/engine.ts:94-118`, `packages/workflow-engine/src/engine.ts:168-177`).
3. The engine records run and step state through its journal and resolves subworkflows with the configured `resolveWorkflow` callback (`packages/workflow-engine/src/engine.ts:168-174`, `packages/workflow-engine/src/journal.ts:150-190`).
4. The host can use draft-store operations to edit and test definitions, then publish through the file writer with compare-and-swap protection (`packages/workflow-engine/src/draft-store.ts:81-109`, `packages/workflow-engine/src/files.ts:17-39`).

## Public API and configuration

The default export surface re-exports workflow modules from `src/index.ts`; notable entry points include `WorkflowEngine`, `loadWorkflowStore`, `createWorkflowCatalog`, `loadWorkflow`/`parseWorkflow`, `createDraftStore`, `createJournal`, and `createStatusResolver` (`packages/workflow-engine/src/index.ts:1-30`). Engine configuration is passed to `EngineOptions`; `db` and `harnessVersion` are required, while resume policy, compatibility version, runtime construction, admission, lease duration, goal auditing, and event notification are optional (`packages/workflow-engine/src/engine.ts:94-118`).

## Consumers

The repository root application imports this package from its workflow, storage, critique, and schedule rooms; the package manifest does not name other workspace packages as dependents (`src/rooms/workflow/index.ts:1-10`, `src/rooms/storage/database.ts:16-18`, `src/rooms/critique/critique.ts:1-6`, `src/rooms/schedule/time.ts:1-12`, `packages/workflow-engine/package.json:1-14`).

## Where to look next

- [Execution engine](features/execution-engine.md)
- [Workflow definitions and validation](features/definitions-validation.md)
- [Routing and handoff](features/routing-handoff.md)
- [Draft authoring](features/draft-authoring.md)
- [Quality, artifacts, and requirements](features/quality-contracts.md)
- [UI projections and schedule helpers](features/ui-projections.md)
- [Data model overview](data-model.md)
- [Gotchas](gotchas.md)
