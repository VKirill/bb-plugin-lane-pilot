---
title: Workflow Engine Gotchas
type: gotchas
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [workflow-engine, gotchas]
sources:
  - packages/workflow-engine/src/engine.ts
  - packages/workflow-engine/src/db.ts
  - packages/workflow-engine/src/journal.ts
  - packages/workflow-engine/src/ops-store.ts
  - packages/workflow-engine/src/store.ts
  - packages/workflow-engine/src/draft-store.ts
  - packages/workflow-engine/src/preflight.ts
---
# Workflow Engine Gotchas
TL;DR: The main sharp edges are executor side-effect recovery, what counts as a valid workflow override, and draft state being tied to a specific content version.

## Critical

### External effects outside the effect API are not journaled

**Problem:** `ctx.effect` records intent and outcome so the engine can reconcile external work after reload; a direct external call bypasses that record (`packages/workflow-engine/src/engine.ts:64-65`).

**Risk:** A restarted or reentrant executor can repeat an external operation whose completion was not recorded.

**Workaround:** Route retry-sensitive external operations through `ctx.effect` and provide `reconcile` when the external system can report whether the operation happened (`packages/workflow-engine/src/engine.ts:40-40`, `packages/workflow-engine/src/engine.ts:664-695`).

## High

### A graph-invalid narrow-scope workflow can hide a valid wider one

**Problem:** Parse/schema-invalid files are excluded before origin precedence. A structurally valid project definition wins over the global/built-in definition first, then graph/reference validation can exclude that winning ID without restoring the lower-precedence definition (`packages/workflow-engine/src/store.ts:71-93`).

**Risk:** A project file with a familiar ID and a graph/reference error can make that workflow ID absent from the catalog, even when a valid global or built-in definition exists.

**Workaround:** Inspect `WorkflowStore.problems`, then fix the winning definition or remove it so the wider-scope definition can be selected (`packages/workflow-engine/src/store.ts:28-37`, `packages/workflow-engine/src/store.ts:95-103`).

### A tested draft can become draft again after a content edit

**Problem:** Non-UI edits and restore increment the version and set status to `draft`; test receipts are stored only for the matching version (`packages/workflow-engine/src/draft-store.ts:130-145`, `packages/workflow-engine/src/draft-store.ts:165-173`).

**Risk:** A prior green result does not certify changed workflow content.

**Workaround:** Run the draft tests again after a definition edit. Canvas-only UI placement changes update the current snapshot without changing workflow version (`packages/workflow-engine/src/draft-store.ts:130-136`).

## Medium

### Unverified requirements do not make preflight fail

**Problem:** Failed or unavailable host checks create `unverified` issues; `ok` is false only when an issue has level `missing` (`packages/workflow-engine/src/preflight.ts:79-90`, `packages/workflow-engine/src/preflight.ts:127`).

**Risk:** A passing preflight can include requirements the host could not confirm.

**Workaround:** Review `issues` as well as `ok` when deciding whether to start a workflow (`packages/workflow-engine/src/preflight.ts:24-33`, `packages/workflow-engine/src/preflight.ts:73-78`).

### A database handle is required; the package does not initialize a database

**Problem:** `WorkflowEngine` and the stores receive an existing `LanePilotDatabase`, which is a `better-sqlite3` handle (`packages/workflow-engine/src/db.ts:1-4`, `packages/workflow-engine/src/engine.ts:94-99`).

**Risk:** Constructing the engine before the host applies `workflowMigrations`, `draftMigrations`, and `workflowOpsMigrations` leaves required tables absent (`packages/workflow-engine/src/journal.ts:10-12`, `packages/workflow-engine/src/draft-store.ts:9-12`, `packages/workflow-engine/src/ops-store.ts:14-17`).

**Workaround:** Apply the workspace migrations through the host database migration sequence before creating these stores.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](overview.md)
