---
title: Workflow Draft and Operations Data
type: data-model
created: 2026-10-10
updated: 2026-11-23
status: active
confidence: medium
tags: [workflow-engine, data-model, drafts]
sources:
  - packages/workflow-engine/src/draft-store.ts
  - packages/workflow-engine/src/ops-store.ts
  - packages/workflow-engine/src/store.ts
  - packages/workflow-engine/src/business-outcome.ts
  - packages/workflow-engine/src/validate.ts
---
# Workflow Draft and Operations Data
TL;DR: Draft records hold editable workflow content and snapshots; operational rows bind exact workflow hashes to test receipts and schedule automation records.

## Relationships

```mermaid
erDiagram
  DRAFT ||--o{ DRAFT_VERSION : snapshots
  TEST_RECEIPT }o..|| WORKFLOW : identifies
  TRIGGER }o..|| WORKFLOW : schedules
```

Workflow associations in operational tables use IDs and hashes, not declared foreign keys (`packages/workflow-engine/src/draft-store.ts:11-38`, `packages/workflow-engine/src/ops-store.ts:15-41`).

## Tables

### `lane_pilot_wf_draft`

Purpose: Current editable workflow, project/thread ownership, status, tests, and published-file pointer (`packages/workflow-engine/src/draft-store.ts:11-27`).

| Field | Meaning |
|---|---|
| `id` | Draft ID primary key; generated with `wfd_` prefix. |
| `project_id` | Owning project ID. |
| `thread_id` | Optional creating/editing conversation thread. |
| `scope` | `global` or `project`. |
| `workflow_id` | Workflow identifier represented by this draft. |
| `status` | `draft`, `tested`, or `published`; defaults to `draft`. |
| `version` | Current edit version, starting at 1. |
| `definition_json` | Current serialized workflow definition. |
| `tests_json`, `tested_version` | Nullable test results and version they cover. |
| `published_version`, `published_path`, `published_sha256` | Nullable workflow version, file path, and content hash recorded at publication. |
| `created_at`, `updated_at` | Millisecond timestamps. |

Status lifecycle:

| From | To | Function | When |
|---|---|---|---|
| New | `draft` | `create` (`packages/workflow-engine/src/draft-store.ts:100-116`) | Initial draft row is inserted. |
| Any editable status | `draft` | `patch`, `restore`, `replaceDefinition` (`packages/workflow-engine/src/draft-store.ts:127-152`, `packages/workflow-engine/src/draft-store.ts:155-169`, `packages/workflow-engine/src/draft-store.ts:196-211`) | Definition changes, prior version is restored, or full definition is replaced. UI-only changes keep status. |
| `draft` | `tested` or `draft` | `recordTests` (`packages/workflow-engine/src/draft-store.ts:172-180`) | Current version has nonempty complete all-green results, else status remains draft. |
| Matching current version | `published` | `markPublished` (`packages/workflow-engine/src/draft-store.ts:182-186`) | Caller records the published file metadata. |
| Any status | `draft` | `resetToFactoryBaseline` (`packages/workflow-engine/src/draft-store.ts:189-193`) | Global overlay is rolled back to its factory built-in workflow, clearing test and publication metadata. |

Invariants: scope/status are SQL-constrained; draft edits use version checks; project listing is ordered by update time (`packages/workflow-engine/src/draft-store.ts:11-28`, `packages/workflow-engine/src/draft-store.ts:119-124`). The resolver separately requires a green receipt for the exact current file hash (current or legacy hash) before an owner-authored `tested` or `published` file counts as tested/published (`packages/workflow-engine/src/ops-store.ts:124-137`).

Writers/readers: `createDraftStore` writes and reads draft rows (`list`, `listEvolutionDrafts`, `latestPublishedSnapshot`, `previousVersionSnapshot`); workflow editor/library and evolution code use it. No draft cleanup or retention function is defined in this workspace (`packages/workflow-engine/src/draft-store.ts:87-271`).

### `lane_pilot_wf_draft_version`

Purpose: Definition snapshot and operation summary for each draft version (`packages/workflow-engine/src/draft-store.ts:29-37`).

| Field | Meaning |
|---|---|
| `draft_id`, `version` | Composite primary key identifying the snapshot. |
| `definition_json` | Full definition snapshot at that version. |
| `summary` | Creation, edit summary, or restore description. |
| `ops_json` | Nullable serialized operations that produced the snapshot. |
| `at` | Snapshot timestamp in milliseconds. |

Invariants: `(draft_id,version)` is primary key; restore and full replacement create a new version rather than overwriting prior history (`packages/workflow-engine/src/draft-store.ts:29-37`, `packages/workflow-engine/src/draft-store.ts:155-169`, `packages/workflow-engine/src/draft-store.ts:196-211`). Draft creation, patch, restore, and full definition replacement write snapshots; `history`, `definitionAt`, `latestPublishedSnapshot`, and `previousVersionSnapshot` (which verifies candidate snapshots with `loadWorkflow`) read them (`packages/workflow-engine/src/draft-store.ts:110-114`, `packages/workflow-engine/src/draft-store.ts:213-220`, `packages/workflow-engine/src/draft-store.ts:239-269`). No retention job is defined.

### `lane_pilot_wf_test`

Purpose: Test receipt keyed by workflow ID and exact definition SHA-256 (`packages/workflow-engine/src/ops-store.ts:17-24`).

| Field | Meaning |
|---|---|
| `workflow_id`, `definition_sha256` | Composite key for workflow content tested. |
| `green` | Integer boolean: 1 for green, 0 otherwise. |
| `results_json` | Serialized test results. |
| `at` | Receipt timestamp in milliseconds. |

No status lifecycle field. `recordTest` upserts receipts; `resolve` checks the exact hash (with legacy hash fallback), and `liveSuccess` lifts a `tested` workflow to `published` only on the newest live run of this version that proves the chain: the run's `workflow_sha256` must equal the current `definitionSha256` or the older hash that still included canvas positions, and its output must finish the job per the shared business-outcome reading with the chain's `live_success` rule (`packages/workflow-engine/src/ops-store.ts:97-114`, `packages/workflow-engine/src/ops-store.ts:135`; the outcome reading in [run journal data](run-journal.md), `packages/workflow-engine/src/business-outcome.ts:25-40`). A workflow edited after its proving run has a different definition hash, so that run no longer proves it and the workflow stays `tested`. No cleanup job is defined.

### `lane_pilot_wf_trigger`

Purpose: Maps one workflow/project/schedule slot to a host automation and the signature used to create it (`packages/workflow-engine/src/ops-store.ts:26-35`).

| Field | Meaning |
|---|---|
| `workflow_id`, `project_id`, `slot` | Composite primary key for workflow schedule slot. |
| `automation_id` | Host automation identifier. |
| `signature` | Source configuration signature used for synchronization. |
| `created_at`, `updated_at` | Millisecond timestamps. |

No lifecycle status field. The workflow trigger integration writes and reads these associations; this workspace defines the table and migration only (`packages/workflow-engine/src/ops-store.ts:26-35`). No retention job is defined.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine Data Model](../data-model.md)
- [Workflow Run Journal Data](run-journal.md)
