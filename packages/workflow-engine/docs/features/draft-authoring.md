---
title: Workflow Draft Authoring
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [workflow-engine, drafts, authoring]
sources:
  - packages/workflow-engine/src/draft.ts
  - packages/workflow-engine/src/draft-store.ts
  - packages/workflow-engine/src/draft-test.ts
  - packages/workflow-engine/src/draft-view.ts
  - packages/workflow-engine/src/files.ts
---
# Workflow Draft Authoring
TL;DR: Draft authoring applies validated workflow edits as versioned operations, runs test cases against stubbed executors, and records publication metadata after a guarded file write.

## Purpose

The authoring API stores editable definitions and version history, applies structured operations, exposes a view/diff for editor clients, runs draft cases through a test engine, and tracks test and publish state (`packages/workflow-engine/src/draft-store.ts:81-109`, `packages/workflow-engine/src/draft-test.ts:117-123`).

## How it works

1. `createDraftStore(db)` returns operations over the draft and version tables. `create` assigns an ID, derives or accepts a workflow ID, creates or copies a definition, and writes version 1 transactionally (`packages/workflow-engine/src/draft-store.ts:81-109`).
2. `patch` checks existence and optional expected version, applies all draft operations, and refuses the whole patch if an operation cannot be applied (`packages/workflow-engine/src/draft-store.ts:120-128`).
3. UI-only layout changes update the current version in place. Definition changes increment the version, append history, and return status to `draft` (`packages/workflow-engine/src/draft-store.ts:130-145`).
4. `checkDraft` validates the resulting definition. Test cases can provide inputs, human answers, keyed stubs, and unchecked declarations (`packages/workflow-engine/src/draft.ts:150-157`, `packages/workflow-engine/src/draft-test.ts:17-55`).
5. `runDraftTest` preflights and runs each case in a separate `draft-test.<workflow id>` run. External executors are stubbed; pure actions and reducers execute as code unless the case overrides them (`packages/workflow-engine/src/draft-test.ts:117-123`, `packages/workflow-engine/src/draft-test.ts:143-174`).
6. `recordTests` marks the current matching version `tested` only when the run is complete, at least one case exists, and every result is green. `markPublished` records path, hash, and workflow version for the matching draft version (`packages/workflow-engine/src/draft-store.ts:165-179`).
7. The host writes the definition with `casWriteWorkflowFile`; it compares the current file hash with the expected hash and atomically renames a temporary file into place (`packages/workflow-engine/src/files.ts:17-39`).

## Modes and failures

| Branch | Result |
|---|---|
| Missing draft | Patch/restore returns `not_found` (`packages/workflow-engine/src/draft-store.ts:123-125`, `packages/workflow-engine/src/draft-store.ts:151-153`). |
| Expected-version mismatch | Patch/restore returns `version_conflict` with the current version and makes no edit (`packages/workflow-engine/src/draft-store.ts:125`, `packages/workflow-engine/src/draft-store.ts:153`). |
| Refused operation | Patch returns `refused` with operation-level refusals; no operations are saved (`packages/workflow-engine/src/draft-store.ts:126-128`). |
| UI-only operation | Stores new UI JSON in current draft and current history row without incrementing version or clearing test/publication state (`packages/workflow-engine/src/draft-store.ts:130-136`). |
| Definition edit or restore | Increments version and returns status to `draft`; history keeps the prior version and the new one (`packages/workflow-engine/src/draft-store.ts:138-145`, `packages/workflow-engine/src/draft-store.ts:148-161`). |
| Incomplete, empty, or failing test set | Current version remains `draft`; successful tests require complete=true, a nonempty results list, and every case green (`packages/workflow-engine/src/draft-store.ts:165-173`). |
| Publish hash conflict | Writer returns `status: conflict` and does not replace the existing file (`packages/workflow-engine/src/files.ts:21-30`). |

## Business rules

- Draft scope is `global` or `project`; project scope attaches the given project ID to the definition (`packages/workflow-engine/src/draft-store.ts:15-16`, `packages/workflow-engine/src/draft-store.ts:94-103`).
- A draft patch is all-or-nothing if any operation is refused (`packages/workflow-engine/src/draft-store.ts:120-128`).
- Canvas placement changes do not create a new content version; all other edits invalidate prior test and publication state by setting status to `draft` (`packages/workflow-engine/src/draft-store.ts:130-145`).
- A test receipt is tied to the exact version number; stale test results are not written when the requested version no longer matches (`packages/workflow-engine/src/draft-store.ts:165-173`).
- Workflow file IDs must match a lowercase-leading pattern of up to 48 lowercase letters, digits, periods, or hyphens (`packages/workflow-engine/src/files.ts:6`, `packages/workflow-engine/src/files.ts:21-23`).

## Public API

| Import | Purpose |
|---|---|
| `createDraftStore`, `DraftStore`, `DraftRow`, `PatchResult`, `RestoreResult` | Persist drafts, versions, test results, and publish metadata (`packages/workflow-engine/src/draft-store.ts:40-80`, `packages/workflow-engine/src/draft-store.ts:81-193`). |
| `draftOpSchema`, `applyDraftOps`, `checkDraft`, `newDraftDefinition` | Validate and apply edit operations (`packages/workflow-engine/src/draft.ts:24-35`, `packages/workflow-engine/src/draft.ts:63-178`). |
| `runDraftTest`, `testCasesOf`, `DraftTestCase`, `DraftTestResult` | Execute authored test cases in the draft harness (`packages/workflow-engine/src/draft-test.ts:17-55`, `packages/workflow-engine/src/draft-test.ts:72-177`). |
| `draftView`, `draftChanges` | Create editor-facing definition and change views (`packages/workflow-engine/src/draft-view.ts:63-102`). |
| `casWriteWorkflowFile`, `sha256Text`, `WORKFLOW_FILE_ID` | Publish a definition with content-hash conflict detection (`packages/workflow-engine/src/files.ts:6-39`). |

## Package shape

`draft.ts` defines edits; `draft-store.ts` persists versions and status; `draft-test.ts` executes test cases; `draft-view.ts` creates editor projections; `files.ts` handles file publication (`packages/workflow-engine/src/draft.ts:1-10`, `packages/workflow-engine/src/draft-store.ts:1-8`, `packages/workflow-engine/src/draft-test.ts:1-12`).

## Internal model

`lane_pilot_wf_draft` is the current editable row and `lane_pilot_wf_draft_version` is the append-only logical history of definition snapshots and operation summaries. The draft row stores the latest definition and test/publication pointers (`packages/workflow-engine/src/draft-store.ts:11-38`, `packages/workflow-engine/src/draft-store.ts:43-60`).

Test execution uses a real `WorkflowEngine` journal but supplies generated outputs for external node types. This means tests exercise graph routing and deterministic code while replacing host-dependent work with case stubs (`packages/workflow-engine/src/draft-test.ts:117-123`, `packages/workflow-engine/src/draft-test.ts:143-169`).

## Dependencies

The draft store requires the shared `LanePilotDatabase`; tests use the execution engine and workflow lowering/validation modules (`packages/workflow-engine/src/draft-store.ts:1-8`, `packages/workflow-engine/src/draft-test.ts:1-10`).

## Gotchas

- A successful file write and `markPublished` are separate operations; the caller owns the ordering and must pass the matching version and hash (`packages/workflow-engine/src/files.ts:21-39`, `packages/workflow-engine/src/draft-store.ts:176-179`).
- Test stubs match multiple keys, including node ID, action, subworkflow ID, and node type; broad keys can affect more than one step (`packages/workflow-engine/src/draft-test.ts:124-142`).

## Draft operation and display details

### `draftOpSchema`

The schema is a strict discriminated union on `op`. It accepts seven operations: add/update/remove node, add/update/remove edge, and set metadata. Updates default `set` to an empty object; node update allows up to 30 nonempty unset keys of at most 60 characters; edge update allows up to 10. Node removal defaults `cascade` to true. Edge updates/removals require an edge selector; a selector names an edge by index or by both `from` and `to`, with optional `when` disambiguation (`packages/workflow-engine/src/draft.ts:16-32`).

Unknown operations, extra keys, malformed operation payloads, and selectors that provide neither an index nor both endpoints fail Zod parsing. The operation schema checks operation shape only; application-level conflicts/refusals are returned by `applyDraftOps` and graph validity is checked separately by `checkDraft` (`packages/workflow-engine/src/draft.ts:16-32`, `packages/workflow-engine/src/draft.ts:63-122`, `packages/workflow-engine/src/draft.ts:150-157`).

### `draftView`

`draftView` accepts unknown raw input and treats non-object input as an empty definition. It converts array entries with usable node IDs to view nodes; unknown node type strings fall back to `agent`, while missing IDs and non-object nodes are omitted. It reads raw edges, translates `start`/`end` to sentinels when no node of that name exists, and synthesizes a start edge from `entry` if no start edge was supplied (`packages/workflow-engine/src/draft-view.ts:30-50`, `packages/workflow-engine/src/draft-view.ts:63-73`).

During edge projection it omits edges with missing endpoints or endpoints that do not exist in the partial node set (except sentinels). Recognized pass modes are retained; every other pass value becomes `artifact`. It then adds start/end display nodes when used and keeps only UI positions whose `x` and `y` are numbers (`packages/workflow-engine/src/draft-view.ts:54-60`, `packages/workflow-engine/src/draft-view.ts:74-85`).

The result is a partial `WorkflowView`, not a validation result: malformed portions are skipped or defaulted, and there is no failure object or diagnostic list. `draftChanges` separately compares node JSON and edge signatures against a previous view; with no previous view it reports no changes (`packages/workflow-engine/src/draft-view.ts:88-102`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Workflow Engine — Overview](../overview.md)
