---
title: Workflow chain executors
type: component
created: 2026-10-30
updated: 2026-11-23
status: active
confidence: medium
tags: [workflow, executors, chains, dispatch, plan-critique]
sources:
  - src/rooms/workflow/server/services/workflow-executors.ts
  - src/rooms/workflow/server/services/workflow-human-form.ts
  - src/rooms/workflow/server/services/workflow-lp-task.ts
  - src/rooms/workflow/server/services/workflow-checkout-actions.ts
  - src/rooms/workflow/server/services/workflow-project-actions.ts
  - src/rooms/workflow/server/services/workflow-task-book.ts
  - src/rooms/workflow/server/services/workflow-delegated-actions.ts
  - src/rooms/workflow/server/services/workflow-deliverable.ts
  - packages/workflow-engine/src/step-read.ts
  - src/rooms/writer/server/services/dispatch.ts
  - src/rooms/tasks/models/task-v2.ts
  - packages/workflow-engine/src/engine.ts
  - tests/workflow/chain-executors.test.ts
  - tests/workflow/human-form-no-reask.test.ts
---

# Workflow chain executors

TL;DR: Node executors registered on the workflow engine to run chain tasks, agent/plan/script nodes, owner interactions, and artifact validations.

## Purpose

Workflow chain executors provide the execution layer for multi-step declarative workflows in Lane Pilot. They connect workflow nodes to underlying subsystems: dispatching writer tasks, collecting owner decisions, validating non-code deliverables, and invoking delegated helper commands.

## How it works

1. `registerChainExecutors` registers node executors and action delegates on the shared `WorkflowEngine` instance (`src/rooms/workflow/server/services/workflow-executors.ts`).
2. Artifact validation executes through `deliverable.validate` (registered from `src/rooms/workflow/server/services/workflow-deliverable.ts`), inspecting target paths or URLs with domain validators, host commands, and agent visual reviews.
3. The `agent` executor supports `form: "agent" | "plan" | "script"` with declared `fallback` chains (`packages/workflow-engine/src/node-form.ts`), resolving node-level model overrides before role-table defaults, writing large input packets to the workspace, and running the assigned role or script (`src/rooms/workflow/server/services/workflow-executors.ts`).
4. Human interaction in `builtin:human` (`src/rooms/workflow/server/services/workflow-human-form.ts`) composes an owner-facing question in the owner's language and shows a BB form in the PM chat, or parks the question on the owner's list (`workflow_question`) when no PM thread is active, dismissed, or timed out. Step deadlines use absolute epoch ms timestamps (`72h` default).
5. The `lp-task` executor resolves the contract and quality mode, lints the task, prepares the canonical plan, and calls `dispatchWriter` (`src/rooms/workflow/server/services/workflow-lp-task.ts`, `src/rooms/writer/server/services/dispatch.ts`).
6. Workspace file operations execute through `fs.write` and diff inspection through `git.diff_files` (`src/rooms/workflow/server/services/workflow-checkout-actions.ts`).
7. Contract linting in `lp.lint_contract` validates tasks and checks wave path disjointness (`src/rooms/workflow/server/services/workflow-task-book.ts`).

| Executor | Input | Output | Failure mode |
|---|---|---|---|
| `lp-task` | Task contract, quality mode, timeout | Attempt state, merge commit, changed files, usage | Contract lint failure yields `failed`; rejection yields `blocked` (`src/rooms/workflow/server/services/workflow-lp-task.ts`). |
| `deliverable.validate` | Validator name, target path, brief, host id | Verdict (`pass` or `rework`), reason, issue details | Missing/empty/unsafe target or unproven producer location returns named `rework` (`src/rooms/workflow/server/services/workflow-deliverable.ts`). |
| `builtin:human` | Instruction prompt, timeout, options | Form response or owner item answer | Missing PM thread, dismissed form, or form-level timeout parks `workflow_question` without re-opening the form on polls (`src/rooms/workflow/server/services/workflow-human-form.ts`). |
| `fs.write` | File path, contents template or reads list | Folder path, handoff path, written file paths | Paths traversing outside checkout throw an error (`src/rooms/workflow/server/services/workflow-checkout-actions.ts`). |
| `git.diff_files` | Commit range, PR number, or files array | Kept files list, count, level (`quick`/`standard`/`deep`) | Host git failure throws clipped stderr message. |
| `lp.lint_contract` | Plan tasks and wave groupings | Boolean `ok`, array of validation and clash errors | Wave path overlap or invalid task contracts append error strings (`src/rooms/workflow/server/services/workflow-task-book.ts`). |

## Business rules

- **Canonical plan contains concrete file steps.** `task.files[]` actions are appended to `task.objective` under `Planned changes:`, while reentrant dispatch retains `getTaskPlan` unmodified (`src/rooms/workflow/server/services/workflow-lp-task.ts`).
- **Wave path isolation.** Concurrent tasks in the same wave must have disjoint `owns_paths`.
- **Deliverable targets carry proven provenance.** `deliverable.validate` resolves the exact producer step along `parent_key` ancestry via `packages/workflow-engine/src/step-read.ts` (`src/rooms/workflow/server/services/workflow-deliverable.ts`).

## Public API or commands

`registerChainExecutors` registers node executors (`deliverable.validate`, `agent`, `builtin:human`, `lp-task`), state/checkout actions (`fs.write`, `git.diff_files`, `lp.state_probe`, `lp.run_status`, `lp.integration_gate_status`, `lp.run_close`, `lp.lint_contract` in `src/rooms/workflow/server/services/workflow-project-actions.ts`), and delegated errand actions (`src/rooms/workflow/server/services/workflow-delegated-actions.ts`).

## Gotchas

- An `lp-task` node specifying neither an explicit contract nor a `contract_template` falls back to an empty template rejected by contract linting.
- A dismissed or unparented `builtin:human` step parks `workflow_question` until answered via `workflow_answer` or the step deadline (`72h` default).

