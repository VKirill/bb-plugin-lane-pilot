---
title: Workflow chain executors
type: component
created: 2026-10-30
updated: 2026-11-23
status: active
confidence: medium
tags: [workflow, executors, chains, dispatch, plan-critique]
sources:
  - src/rooms/workflow/server/workflow-executors.ts
  - src/rooms/workflow/server/workflow-human-form.ts
  - src/rooms/workflow/server/workflow-lp-task.ts
  - src/rooms/workflow/server/workflow-checkout-actions.ts
  - src/rooms/workflow/server/workflow-project-actions.ts
  - src/rooms/workflow/server/workflow-task-book.ts
  - src/rooms/workflow/server/workflow-delegated-actions.ts
  - src/rooms/workflow/server/workflow-deliverable.ts
  - packages/workflow-engine/src/step-read.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/tasks/task-v2.ts
  - packages/workflow-engine/src/engine.ts
  - tests/workflow/chain-executors.test.ts
  - tests/workflow/human-form-no-reask.test.ts
---

# Workflow chain executors

TL;DR: Node executors registered on the workflow engine to run chain tasks, agent turns, owner interactions, and artifact validations.

## Purpose

Workflow chain executors provide the execution layer for multi-step declarative workflows in Lane Pilot. They connect workflow nodes to underlying subsystems: dispatching writer tasks, collecting owner decisions, validating non-code deliverables, and invoking delegated helper commands.

## How it works

1. `registerChainExecutors` registers node executors and action delegates on the shared `WorkflowEngine` instance (`src/rooms/workflow/server/workflow-executors.ts:37-180`).
2. Artifact validation executes through `deliverable.validate` (registered from `src/rooms/workflow/server/workflow-deliverable.ts`), inspecting target paths or URLs with domain validators, host commands, and agent visual reviews. The target comes from the node's declared `params`, then the exact persisted edge `with` mapping of the delivery, and run inputs only when nothing is declared; a declared-but-empty target is a named `rework`, never a fallback (`src/rooms/workflow/server/workflow-deliverable.ts:34-52`).
3. The `agent` executor writes large input packets to the workspace and invokes the assigned agent model role (`src/rooms/workflow/server/workflow-executors.ts:57-146`).
4. Human interaction in `builtin:human` (registered by `registerHumanForm` at `src/rooms/workflow/server/workflow-executors.ts:149`) composes an owner-facing question in the owner's language and shows a BB form in the PM chat, or parks the question on the owner's list (`workflow_question`) when no PM thread is active or when the owner dismisses the form or lets it time out so subsequent polls do not re-open the chat form (`src/rooms/workflow/server/workflow-human-form.ts:104`, `:135-184`, `:197-214`).
5. The `lp-task` executor resolves the contract and quality mode, lints the task, prepares the canonical plan, and calls `dispatchWriter` (`src/rooms/workflow/server/workflow-lp-task.ts:34-65`).
6. When constructing the canonical plan for a workflow task, concrete planner steps from `task.files[]` are appended to `task.objective` with their action, path, target, and change, while reentrant dispatches reuse `getTaskPlan` from storage (`src/rooms/workflow/server/workflow-lp-task.ts:56-57`).
7. The `lp-task` poller monitors attempt progress, resolves terminal attempt states, extracts merge commit facts from git trailers, and tallies token and dollar usage (`src/rooms/workflow/server/workflow-lp-task.ts:66-82`).
8. Workspace file operations execute through `fs.write`, formatting JSON or Markdown reports into the active checkout (`src/rooms/workflow/server/workflow-checkout-actions.ts:86-356`).
9. Diff inspection in `git.diff_files` collects changed paths from ranges, PR references, or explicit file arrays on the host (`src/rooms/workflow/server/workflow-checkout-actions.ts:358-374`).
10. Contract linting in `lp.lint_contract` validates tasks and verifies that concurrent tasks within the same wave do not claim overlapping owned paths (`src/rooms/workflow/server/workflow-task-book.ts:30-71`).

| Executor | Input | Output | Failure mode |
|---|---|---|---|
| `lp-task` | Task contract, quality mode, timeout | Attempt state, merge commit, changed files, usage | Contract lint failure yields `failed`; rejection yields `blocked` (`src/rooms/workflow/server/workflow-lp-task.ts:49-59`). |
| `deliverable.validate` | Validator name, target path, brief, host id | Verdict (`pass` or `rework`), reason, issue details | Missing/empty/unsafe target or unproven producer location returns named `rework`; validator issues return `rework` (`src/rooms/workflow/server/workflow-deliverable.ts:52,74-169,184-198`). |
| `builtin:human` | Instruction prompt, timeout, options | Form response or owner item answer | Missing PM thread, dismissed form, or form-level timeout parks the question on the owner list (`workflow_question`) with CLI and RPC actions without re-opening the form on polls; step deadline expiration returns `timeout`, `defaultOption`, or `human_timeout` (`src/rooms/workflow/server/workflow-human-form.ts:135-184`, `:197-214`, `tests/workflow/human-form-no-reask.test.ts:65-88`). |
| `fs.write` | File path, contents template or reads list | Folder path, handoff path, written file paths | Paths traversing outside checkout throw an error (`src/rooms/workflow/server/workflow-checkout-actions.ts:92`). |
| `git.diff_files` | Commit range, PR number, or files array | Kept files list, count, level (`quick`/`standard`/`deep`) | Host git failure throws clipped stderr message (`src/rooms/workflow/server/workflow-checkout-actions.ts:368`). |
| `lp.lint_contract` | Plan tasks and wave groupings | Boolean `ok`, array of validation and clash errors | Wave path overlap or invalid task contracts append error strings (`src/rooms/workflow/server/workflow-task-book.ts:38-70`). |

## Business rules

- **Canonical plan contains concrete file steps.** For tasks dispatched in a workflow chain, `task.files[]` represents concrete implementation steps. The chain executor appends each file's action, path, target, and change to `task.objective` under a `Planned changes:` header so that the plan critic has visibility into planned file modifications (`src/rooms/workflow/server/workflow-lp-task.ts:56-57`).
- **Reentrant plan preservation.** If a task already has a plan stored in SQLite, reentrant dispatch retains `getTaskPlan(db, valid.task.id)` unmodified. This guarantees that duplicate task detection based on SHA-256 plan hashes remains stable across workflow reloads (`src/rooms/workflow/server/workflow-lp-task.ts:56-58`, `src/rooms/writer/server/dispatch.ts:124-136`).
- **Wave path isolation.** Tasks grouped in the same wave run concurrently. Their owned paths must be disjoint; any overlap causes `lp.lint_contract` to fail before dispatch (`src/rooms/workflow/server/workflow-task-book.ts:30-65`).
- **Attempt merge fact extraction.** An accepted task attempt's merge commit is verified by searching git log on the host for the `Lane-Pilot-Attempt:` commit trailer (`src/rooms/workflow/server/workflow-lp-task.ts:118-127`).
- **Deliverable targets carry proven provenance.** When the target is an edge- or template-mapped node reference, `deliverable.validate` resolves the exact producer step (delivery-row ceiling for edge mappings, latest-in-scope for execution-time `{{ref}}` params templates), requires it on the delivering step's `parent_key` ancestry, and reads the location that producer's own contract proves: a single agent's bound thread environment, `fs.write`'s PM checkout or planning home, or — for a direct `subworkflow` child — the child's run-file registry row and recorded run home (`kind:"output"`, `root:"checkout"` only; planning-home rows stay unverified because the historical planning root is not recorded). `node.with` overrides, rerun-patched inputs, multi-vote producers, unreadable environments and unsupported producer types are named `rework` (`producer provenance unverified`), never inferred (`src/rooms/workflow/server/workflow-deliverable.ts:65-169`, `packages/workflow-engine/src/step-read.ts:18-101`). A fully declared location — explicit host plus absolute path, URL or `~` — bypasses producer lookup entirely; `~` resolves through `hosts.directory`, never shell expansion.

## Public API or commands

`registerChainExecutors` registers the following executors on `WorkflowEngine` (`src/rooms/workflow/server/workflow-executors.ts:37-180`):
- Node executors: `deliverable.validate`, `agent`, `builtin:human`, `lp-task` (`src/rooms/workflow/server/workflow-executors.ts:57-161`, `src/rooms/workflow/server/workflow-human-form.ts:95-215`, `src/rooms/workflow/server/workflow-lp-task.ts:26-136`).
- State and checkout actions: `fs.write`, `git.diff_files`, `lp.state_probe`, `lp.run_status`, `lp.integration_gate_status`, `lp.run_close`, `lp.lint_contract` (`src/rooms/workflow/server/workflow-checkout-actions.ts:86-398`, `src/rooms/workflow/server/workflow-project-actions.ts:117-168`, `src/rooms/workflow/server/workflow-task-book.ts:30-71`).
- Delegated errand actions: `telegram.send_rich`, `shell.skill_script`, `shell.repo_script`, `deploy.post_check`, `lp.preflight`, `lp.project_checks` (`src/rooms/workflow/server/workflow-delegated-actions.ts:14-43`).

## Gotchas

- If an `lp-task` node specifies neither an explicit contract nor a `contract_template`, contract generation falls back to an empty template, which contract linting will reject (`src/rooms/workflow/server/workflow-lp-task.ts:94-114`).
- A human question step with an inactive or absent PM thread, or whose chat form is dismissed or times out at the form layer, does not fail or re-open the form on every poll; it parks a blocking `workflow_question` item on the owner's list via `postOwnerItem` with wake enabled until answered via `workflow_answer` or the step's deadline (`src/rooms/workflow/server/workflow-human-form.ts:135-184`, `:197-214`).
- An attempt wait without an explicit `timeoutSec` uses a fallback deadline of 48 hours to avoid indefinite polling when a task row is purged (`src/rooms/workflow/server/workflow-lp-task.ts:63`).

