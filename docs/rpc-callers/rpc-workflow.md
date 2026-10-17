---
title: Workflow RPC contract
type: component
created: 2026-10-16
updated: 2026-10-17
status: active
confidence: high
tags: [rpc, workflows, contracts]
sources:
  - src/rooms/contracts/rpc-workflow.ts
  - src/rooms/contracts/index.ts
  - src/rooms/workflow/server/rpc/workflows.ts
  - src/rooms/workflow/server/rpc/workflow-ops.ts
  - src/rooms/workflow/server/workflow-library.ts
  - src/rooms/workflow/server/workflow-triggers.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/workflow/server/workflow-ops.ts
---

# Workflow RPC contract

TL;DR: `rpcWorkflow` exposes workflow library reads, run operations, preflight and stubbed trials; the handlers preserve result-level refusals and return null or empty states for missing data.

## Purpose

`rpcWorkflow` defines strict app RPC schemas for reading workflows and starting or inspecting their runs. The contract is assembled into `rpcContract`, and `registerRpc` combines workflow handler factories with the other RPC handlers (`src/rooms/contracts/rpc-workflow.ts:4-6`, `src/rooms/contracts/index.ts:17-26`, `src/rooms/core/server/rpc.ts:27-50`).

## How it works

1. BB validates each request against a strict object schema. The covered methods accept workflow ids, optional project ids, bounded page limits (workflow history defaults to 20), run/node ids, manual or Telegram source, and input records (`src/rooms/contracts/rpc-workflow.ts:6-62`).
2. Library methods load built-in and global workflow sources. When a project is requested, the library resolves its project location and reads project workflow files through the host; no location returns `no_machine`, and host/read failure is logged and becomes `unavailable` with an empty project source (`src/rooms/workflow/server/workflow-library.ts:46-67`).
3. `workflow_list` returns summaries, parse problems, and project source state (`src/rooms/workflow/server/workflow-library.ts:93-99`). `workflow_get` returns `workflow: null` when the id is absent, otherwise details and recent runs (`src/rooms/workflow/server/workflow-library.ts:111-137`); `workflow_run_snapshot` returns `snapshot: null` when the engine has no snapshot (`src/rooms/workflow/server/workflow-library.ts:139-166`).
4. `workflow_runs` queries newest-first history, optionally narrows by project and `before`, fetches one extra row, and returns `hasMore`. `workflow_rerun_node` refuses the built-in `lp-task-pipeline` run; other cases delegate to the engine and return its `ok`, reason, step key, and removed count (`src/rooms/workflow/server/workflow-ops.ts:30-52`).
5. `workflow_preflight` returns `found: false` for a missing id; without both a preflight checker and project id, a found workflow returns `ok: true` with empty checks. Otherwise it returns the preflight issues, env requests, and checked requirements (`src/rooms/workflow/server/workflow-ops.ts:54-60`).
6. `workflow_dry_run` chooses the first declared test case, overlays supplied inputs, runs it with external actions stubbed, and returns its trial result and stub list. A missing workflow returns `found: false`, null result, and no stubs (`src/rooms/workflow/server/workflow-ops.ts:62-70`).
7. `workflow_run_tests` executes every test case with stubs. It is green only when there is at least one case and every case passes; it records the test receipt, invalidates the workflow catalog, syncs project schedules when a project is given, then returns the refreshed status (`src/rooms/workflow/server/workflow-ops.ts:73-89`).
8. `workflow_run` calls the shared trigger service and maps success to run id, created flag, status and `notChecked`; a refusal becomes `ok: false` with reason, message and any missing inputs, issues or env requests. Synchronous start errors become `cannot_start`; a later run rejection is logged with the run id (`src/rooms/workflow/server/rpc/workflow-ops.ts:17-24`, `src/rooms/workflow/server/workflow-triggers.ts:143-149`).

The `rpcWorkflow` contract is an unconditional map of strict methods; omitted defaults are applied by Zod, nullable results represent absent data, and run refusals are output values (`src/rooms/contracts/rpc-workflow.ts:5-62`).

| Procedure | Request branch and declared response |
|---|---|
| `workflow_list`, `workflow_get`, `workflow_run_snapshot` | List optionally scopes to a project and returns workflows, parse problems and project-source state; get optionally scopes and returns nullable detail; snapshot takes a run id and returns nullable snapshot (`src/rooms/contracts/rpc-workflow.ts:6-22`). |
| `workflow_runs`, `workflow_rerun_node` | History takes id, optional project, limit 1–50 default 20 and optional cursor, returning rows plus `hasMore`; node rerun takes run id and node id up to 80 characters and returns `ok` with optional reason, step key and removal count (`src/rooms/contracts/rpc-workflow.ts:24-32`). |
| `workflow_run` | Requires workflow and project ids; inputs default to `{}`, source to manual, and optional `liveTrial` enables tested workflow trial. Response carries success/run fields or refusal reason/message and optional missing inputs, issues and secret requests (`src/rooms/contracts/rpc-workflow.ts:34-44`). |
| `workflow_preflight`, `workflow_dry_run`, `workflow_run_tests` | Preflight returns found/ok plus issues, secret requests and checked requirements; dry run defaults input to `{}` and returns nullable trial result and stub list; tests returns found, green, cases and nullable status (`src/rooms/contracts/rpc-workflow.ts:46-62`). |

Strict object validation rejects undeclared fields, invalid ids, and out-of-range history limits before handler execution (`src/rooms/contracts/rpc-workflow.ts:6-62`).

| Mode or branch | Condition | Result or failure |
|---|---|---|
| Manual start | `source` defaults to `manual`; workflow must be published, or tested with `liveTrial: true`. | Starts through the project PM thread or returns a structured refusal (`src/rooms/contracts/rpc-workflow.ts:34-44`, `src/rooms/workflow/server/workflow-triggers.ts:109-120`). |
| Telegram start | Source is `telegram`. | Workflow must declare a Telegram trigger or returns `no_trigger` (`src/rooms/contracts/rpc-workflow.ts:39-44`, `src/rooms/workflow/server/workflow-triggers.ts:121-123`). |
| Schedule start | Trigger service is also used internally with `schedule` source/origin. | Workflow must declare a schedule trigger; the schedule branch uses its schedule idempotency prefix (`src/rooms/workflow/server/workflow-triggers.ts:121-123`, `:138-146`). |
| Start refusal | Missing workflow; pipeline/internal or unpublished workflow; missing required inputs; no project PM chat; failed preflight; synchronous engine start error. | Returns `unknown_workflow`, `not_runnable`, `missing_inputs`, `no_pm_chat`, `requirements_missing`, or `cannot_start`, with fields available for that refusal (`src/rooms/workflow/server/workflow-triggers.ts:109-149`). |
| Stubbed dry run and tests | Dry run selects first test case; run tests executes all cases. | External actions are stubbed; missing workflow and red test results are returned as values (`src/rooms/workflow/server/workflow-ops.ts:62-89`). |
| Schema or handler failure | Invalid input fails strict Zod validation; store, database, or engine operations can reject. | Validation and uncaught handler errors reject the RPC. Start eligibility failures are returned as structured `ok: false` values (`src/rooms/contracts/rpc-workflow.ts:6-62`, `src/rooms/workflow/server/workflow-triggers.ts:109-149`). |

## Business rules

Only published workflows start directly. A tested workflow starts live only when `liveTrial` is true; pipeline and internal workflows cannot start by hand. Required inputs, a PM chat, trigger compatibility, and preflight requirements are checked before the engine starts (`src/rooms/workflow/server/workflow-triggers.ts:109-136`). Workflow list project-source states distinguish omitted project, missing machine, successful read, and unavailable read (`src/rooms/contracts/rpc-workflow.ts:6-14`, `src/rooms/workflow/server/workflow-library.ts:46-67`).

## Public API or commands

The covered public procedures are `workflow_list`, `workflow_get`, `workflow_run_snapshot`, `workflow_runs`, `workflow_rerun_node`, `workflow_run`, `workflow_preflight`, `workflow_dry_run`, and `workflow_run_tests` (`src/rooms/contracts/rpc-workflow.ts:5-63`). The broader contract also contains draft and architect methods documented by their owning workflow pages.

## Gotchas

- Project workflow files are loaded via a host call; an unavailable host read does not fail list/get by itself, but exposes an unavailable project state and omits project files (`src/rooms/workflow/server/workflow-library.ts:46-67`).
- `workflow_run` business refusals are output objects, while malformed RPC input or unexpected handler failures reject the RPC (`src/rooms/workflow/server/rpc/workflow-ops.ts:17-21`).
- `workflow_rerun_node` never manually restarts `lp-task-pipeline`, even though other finished workflow nodes can be delegated to the engine (`src/rooms/workflow/server/workflow-ops.ts:46-52`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
