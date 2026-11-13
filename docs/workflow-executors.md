---
title: Workflow chain executors
type: component
created: 2026-10-30
updated: 2026-11-08
status: active
confidence: medium
tags: [workflow, executors, chains, dispatch, plan-critique]
sources:
  - src/rooms/workflow/server/workflow-executors.ts
  - src/rooms/writer/server/dispatch.ts
  - src/rooms/tasks/task-v2.ts
  - packages/workflow-engine/src/engine.ts
  - tests/workflow/chain-executors.test.ts
---

# Workflow chain executors

TL;DR: Node executors registered on the workflow engine to run chain tasks, agent turns, owner interactions, and artifact validations.

## Purpose

Workflow chain executors provide the execution layer for multi-step declarative workflows in Lane Pilot. They connect workflow nodes to underlying subsystems: dispatching writer tasks, collecting owner decisions, validating non-code deliverables, and invoking delegated helper commands.

## How it works

1. `registerChainExecutors` registers node executors and action delegates on the shared `WorkflowEngine` instance (`src/rooms/workflow/server/workflow-executors.ts:250-259`).
2. Artifact validation executes through `deliverable.validate`, inspecting target paths or URLs with domain validators, host commands, and agent visual reviews (`src/rooms/workflow/server/workflow-executors.ts:329-351`).
3. The `agent` executor writes large input packets to the workspace and invokes the assigned agent model role (`src/rooms/workflow/server/workflow-executors.ts:372-397`).
4. Human interaction in `builtin:human` composes an owner-facing question in the owner's language or records an inbox item on the owner list when no PM thread is active (`src/rooms/workflow/server/workflow-executors.ts:399-444`).
5. The `lp-task` executor resolves the contract and quality mode, lints the task, prepares the canonical plan, and calls `dispatchWriter` (`src/rooms/workflow/server/workflow-executors.ts:508-536`).
6. When constructing the canonical plan for a workflow task, concrete planner steps from `task.files[]` are appended to `task.objective` with their action, path, target, and change, while reentrant dispatches reuse `getTaskPlan` from storage (`src/rooms/workflow/server/workflow-executors.ts:526-530`).
7. The `lp-task` poller monitors attempt progress, resolves terminal attempt states, extracts merge commit facts from git trailers, and tallies token and dollar usage (`src/rooms/workflow/server/workflow-executors.ts:537-554`).
8. Workspace file operations execute through `fs.write`, formatting JSON or Markdown reports into the active checkout (`src/rooms/workflow/server/workflow-executors.ts:599-623`).
9. Diff inspection in `git.diff_files` collects changed paths from ranges, PR references, or explicit file arrays on the host (`src/rooms/workflow/server/workflow-executors.ts:633-649`).
10. Contract linting in `lp.lint_contract` validates tasks and verifies that concurrent tasks within the same wave do not claim overlapping owned paths (`src/rooms/workflow/server/workflow-executors.ts:703-732`).

| Executor | Input | Output | Failure mode |
|---|---|---|---|
| `lp-task` | Task contract, quality mode, timeout | Attempt state, merge commit, changed files, usage | Contract lint failure yields `failed`; rejection yields `blocked` (`src/rooms/workflow/server/workflow-executors.ts:524-530`). |
| `deliverable.validate` | Validator name, target path, brief, host id | Verdict (`pass` or `rework`), reason, issue details | Target absence throws; validator issues return `rework` (`src/rooms/workflow/server/workflow-executors.ts:335-350`). |
| `builtin:human` | Instruction prompt, timeout, options | Form response or owner item answer | Missing PM thread posts to owner list with CLI and RPC actions (`src/rooms/workflow/server/workflow-executors.ts:433-444`). |
| `fs.write` | File path, contents template or reads list | Folder path, handoff path, written file paths | Paths traversing outside checkout throw an error (`src/rooms/workflow/server/workflow-executors.ts:604`). |
| `git.diff_files` | Commit range, PR number, or files array | Kept files list, count, level (`quick`/`standard`/`deep`) | Host git failure throws clipped stderr message (`src/rooms/workflow/server/workflow-executors.ts:643`). |
| `lp.lint_contract` | Plan tasks and wave groupings | Boolean `ok`, array of validation and clash errors | Wave path overlap or invalid task contracts append error strings (`src/rooms/workflow/server/workflow-executors.ts:703-727`). |

## Business rules

- **Canonical plan contains concrete file steps.** For tasks dispatched in a workflow chain, `task.files[]` represents concrete implementation steps. The chain executor appends each file's action, path, target, and change to `task.objective` under a `Planned changes:` header so that the plan critic has visibility into planned file modifications (`src/rooms/workflow/server/workflow-executors.ts:526-528`).
- **Reentrant plan preservation.** If a task already has a plan stored in SQLite, reentrant dispatch retains `getTaskPlan(db, valid.task.id)` unmodified. This guarantees that duplicate task detection based on SHA-256 plan hashes remains stable across workflow reloads (`src/rooms/workflow/server/workflow-executors.ts:526-530`, `src/rooms/writer/server/dispatch.ts:124-136`).
- **Wave path isolation.** Tasks grouped in the same wave run concurrently. Their owned paths must be disjoint; any overlap causes `lp.lint_contract` to fail before dispatch (`src/rooms/workflow/server/workflow-executors.ts:703-727`).
- **Attempt merge fact extraction.** An accepted task attempt's merge commit is verified by searching git log on the host for the `Lane-Pilot-Attempt:` commit trailer (`src/rooms/workflow/server/workflow-executors.ts:580-583`).

## Public API or commands

`registerChainExecutors` registers the following executors on `WorkflowEngine`:
- Node executors: `deliverable.validate`, `agent`, `builtin:human`, `lp-task` (`src/rooms/workflow/server/workflow-executors.ts:266-587`).
- State and checkout actions: `fs.write`, `git.diff_files`, `lp.state_probe`, `lp.run_status`, `lp.integration_gate_status`, `lp.run_close`, `lp.lint_contract` (`src/rooms/workflow/server/workflow-executors.ts:599-732`).
- Delegated errand actions: `telegram.send_rich`, `shell.skill_script`, `shell.repo_script`, `deploy.post_check`, `lp.preflight`, `lp.project_checks` (`src/rooms/workflow/server/workflow-executors.ts:735-742`).

## Gotchas

- If an `lp-task` node specifies neither an explicit contract nor a `contract_template`, contract generation falls back to an empty template, which contract linting will reject (`src/rooms/workflow/server/workflow-executors.ts:565-572`).
- A human question step with an inactive or absent PM thread does not fail; it registers a blocking item via `postOwnerItem` with wake enabled (`src/rooms/workflow/server/workflow-executors.ts:433-444`).
- An attempt wait without an explicit `timeoutSec` uses a fallback deadline of 48 hours to avoid indefinite polling when a task row is purged (`src/rooms/workflow/server/workflow-executors.ts:534`).

