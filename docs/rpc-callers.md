---
title: RPC and host-call contracts
type: component
created: 2026-09-30
updated: 2026-10-17
status: active
confidence: medium
tags: [rpc, contracts, host-api]
sources:
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/contracts/index.ts
  - src/rooms/contracts/host.ts
  - src/rooms/contracts/rpc-shell.ts
  - src/rooms/settings/server/rpc/preferences.ts
  - src/rooms/native-agent/agent-inventory.ts
  - src/rooms/relay/server/owner-locale.ts
  - src/rooms/council/server/council.ts
  - src/rooms/workflow/server/workflow-executors.ts
  - src/rooms/self-repair/server/self-repair.ts
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/contracts/rpc-native.ts
  - src/rooms/runs/server/rpc/runs.ts
  - src/rooms/runs/server/task-board.ts
  - src/rooms/runs/server/task-graph.ts
  - src/rooms/contracts/rpc-knowledge.ts
  - src/rooms/contracts/rpc-workflow.ts
  - src/rooms/contracts/rpc-ops.ts
  - src/rooms/secrets/server/rpc/jev.ts
  - src/rooms/memory/server/session-memory.ts
  - packages/host-calls/src/run-on-host.ts
  - packages/handoff/src/messages.ts
  - scripts/record_and_guard.py
  - server.ts
  - src/rooms/core/server/core.ts
  - src/rooms/memory/server/memory.ts
  - host.ts
  - packages/contracts/src/schemas.ts
  - src/rooms/host-worker/host-handlers.ts
  - src/rooms/anamnesis/contract.ts
---

# RPC and host-call contracts

TL;DR: The contracts room assembles strict UI RPC schemas and a separate host contract; the core registers one implementation object from domain handlers.

## Purpose

Keep BB app-to-server calls and plugin-server-to-host calls typed independently. The app RPC contract is assembled from shell, native, runs, settings, operations, knowledge, workflow, and world contracts (`src/rooms/contracts/index.ts:17-26`).

## How it works

1. `rpcContract` imports the shell, native, runs, settings, operations, knowledge, workflow, and world maps, spreads them into one `defineRpcContract` call, and exports that value as the room's public RPC contract (`src/rooms/contracts/index.ts:1-26`). Composition is unconditional; optional inputs, enums, bounds, and nullable results are declared on each method. For example, shell methods and run-list requests use strict input objects, so undeclared keys and values outside those schemas fail contract validation (`src/rooms/contracts/rpc-shell.ts:8-18`, `src/rooms/contracts/rpc-runs.ts:33-43`).
2. `registerRpc` calls each handler factory with its declared dependencies: most receive `ctx` and `services`; `stackRpc`, `secretsRpc`, `jevProviderRpc`, `workspaceProviderRpc`, `tokenUsageRpc`, and `selfRepairRpc` receive only `ctx`; council receives `ctx.db` and `services.council`; canary and world receive their respective service (`src/rooms/core/server/rpc.ts:27-50`).
3. It spreads those maps into one handler object, wraps every handler with `timeRpcHandlers`, and calls `ctx.bb.rpc.register(rpcContract, ...)` once (`src/rooms/core/server/rpc.ts:26-51`). It has no feature-gate branch or local catch around registration; a registration error propagates to the caller (`src/rooms/core/server/rpc.ts:27-51`).
4. The timing wrapper awaits each handler and returns its answer unchanged. Rejections are rethrown; `finally` logs elapsed time and distinguishes a refused error from other failures. For successful calls lasting at least 250 ms it also attempts to log serialized answer size; serialization and logging errors are swallowed so they do not change the RPC result (`src/rooms/core/server/rpc-timing.ts:1-2`, `:12-40`).
### Route-family behavior

- `rpcShell` adds schedule contract methods first, then declares locale/preferences, project and section lookup, global settings, agent inventory and profile writes. Locale accepts `auto`, `en`, or `ru`; saving globals carries an expected revision; profile writes validate IDs, prompt length, resource limits and an expected source hash (`src/rooms/contracts/rpc-shell.ts:1-18`, `:20-73`, `:74-109`). These contracts declare input/output shapes; handlers decide conflict outcomes.
- `rpcRuns` request steps, branches, outputs, and failures are documented in [Run RPC contract](rpc-callers/rpc-runs.md).
- `rpcKnowledge` defines council reads and messages, routing hints, rule proposals/scans, [session memory](rpc-callers/session-memory-rpc.md), memory-record operations, documentation status, token usage, secret-issuance history, Jev provider settings, and worktree-provider status/reset; it also spreads in the Anamnesis contract methods (`src/rooms/contracts/rpc-knowledge.ts:2`, `:16-62`, `:63-101`, `:103-131`, `:133-210`). Other route execution and failure behavior is documented in [RPC route details](rpc-details.md).
- `rpcWorkflow` request steps, branches, outputs, and failures are documented in [Workflow RPC contract](rpc-callers/rpc-workflow.md).
- `rpcNative` exposes `list_helper_threads`; when an open run exists, its response can include task nodes and `depends`, `files`, `folder`, or `question` edges (`src/rooms/contracts/rpc-native.ts:127-144`, `src/rooms/runs/server/rpc/runs.ts:46-50`, `:165-169`). The Tasks board and detail card are described in [Tasks board](task-board.md).
- `rpcOps` groups run controls, statistics, deployment drain, self-repair, canary, and stack management. Stack install/connect require `confirmExternalOps`; rollback accepts an optional absolute snapshot path. Several operation outputs are `unknown` at the shared contract, so their success and refusal shapes belong to the implementing room (`src/rooms/contracts/rpc-ops.ts:5-109`).

#### `rpcOps` request and result map

The map uses strict input objects. Declared business refusals are output fields where the schema defines them; `unknown` outputs are intentionally owned by their implementing rooms (`src/rooms/contracts/rpc-ops.ts:5-109`).

| Procedure family | Inputs and outcomes |
|---|---|
| Run controls | `halt_run` takes run id and returns canceled/left attempt ids; `cancel_attempt` and `retry_attempt` take attempt id and return ok/state/reason, with retry also returning attempt id; `resume_runs` takes project id and returns resumed, skipped and finished ids (`src/rooms/contracts/rpc-ops.ts:6-25`). |
| Statistics | Writer brief takes project id and integer `since` plus optional `until`, returning unknown. Critic and reuse stats take project id and 1–90 days defaulting to 7; acceptance stats takes 1–90 days defaulting to 28 and optional project id (`src/rooms/contracts/rpc-ops.ts:27-55`). |
| Deploy and self-repair | `deploy_drain` takes boolean `on`; status calls take empty objects. Self-repair configure accepts optional settings including `maxPerDay` 0–20; tick defaults `dryRun` to true and accepts optional integer `since`. Outputs are unknown at this contract (`src/rooms/contracts/rpc-ops.ts:56-93`). |
| Canary and stack | Canary status takes an empty object. Stack detect/install/connect require project id; install/connect also require `confirmExternalOps`. Rollback takes project id and optional absolute snapshot path. Outputs are unknown (`src/rooms/contracts/rpc-ops.ts:86-109`). |

Extra fields, malformed ids, invalid bounds, or a missing required confirmation field fail strict validation. Handler/transport rejections remain rejections; unknown output shapes are validated only as unknown (`src/rooms/contracts/rpc-ops.ts:5-109`).

#### `rpcRuns` request and result map

`rpcRuns` declares strict request/result schemas for task board and detail data, run summaries, stage results, helper access and the screen snapshot (`src/rooms/contracts/rpc-runs.ts:8-115`).

| Procedure | Input branch and result |
|---|---|
| `task_board`, `task_card` | Board optionally filters project, defaults `doneHours` to 24 (range 1–720), and returns typed board items; task card takes run id plus nullable task id and returns nullable contract, plan, stages, attempts and thread tree (`src/rooms/contracts/rpc-runs.ts:8-35`). |
| `get_run_card`, `native_thread` | Run card takes run id and returns nullable run/task state with optional check-log location; native thread takes thread id and returns nullable token/agent/project metadata (`src/rooms/contracts/rpc-runs.ts:37-62`). |
| Run and stage lists | `list_runs` requires project, optional section, offset ≥0, limit 1–200 and optional `pinOpen`; `list_run_stages` takes run id. Results are run views/count or stage summaries (`src/rooms/contracts/rpc-runs.ts:64-70`). |
| Stage result and helper view | Stage result takes run/task/stage ids and returns `found` plus nullable unknown result. Helper view takes project and optional section and returns mode/origin, roles, catalogs, mandatory entries and providers (`src/rooms/contracts/rpc-runs.ts:72-97`). |
| `get_screen` | Takes project, optional section and optional run limit 1–200; result includes project/host/workspace, settings values and versions, import source, runs, unapplied settings, CLI preview, snapshot/receipt/writer outputs, QA hosts, and nullable writer trace (`src/rooms/contracts/rpc-runs.ts:98-164`). |

Strict validation rejects extra fields and invalid bounds; nullable and `found` fields represent missing records in the contract, while uncaught handler failures reject the RPC (`src/rooms/contracts/rpc-runs.ts:8-115`). See [Run RPC contract](rpc-callers/rpc-runs.md) for execution steps and handler outcomes.

### `rpcKnowledge` contract flow

The route families, input validation, result variants, and failure behavior are documented in [RPC route details](rpc-details.md).

### `rpcShell` contract flow

1. The map spreads schedule methods first, then declares preferences, locale, remembered project, sections, projects, globals, inventory, and agent-profile methods; each object is strict (`src/rooms/contracts/rpc-shell.ts:1-8`, `:12-32`, `:33-72`, `:74-109`).
2. `get_preferences` normalizes unknown saved locale values to `auto`, resolves that value with the UI's suggested locale, stores the resolved `en|ru` locale for owner-facing text, and returns last project or null. `set_locale` stores `auto|en|ru` and records the resolved `en|ru` value; auto uses the suggested locale (`src/rooms/contracts/rpc-shell.ts:8-15`, `src/rooms/settings/server/rpc/preferences.ts:15-29`). Council and self-repair owner forms, plus workflow human-step detail strings, use explicit `en|ru` preference first, then the last resolved locale, then Russian (`src/rooms/relay/server/owner-locale.ts:1-28`, `src/rooms/council/server/council.ts:167`, `src/rooms/workflow/server/workflow-executors.ts:171`, `src/rooms/self-repair/server/self-repair.ts:616`).
3. Project and section reads return lists; section listing delegates to the shared Project Folders helper. Global reads parse stored defaults and revision, list profiles, and attach host data; host-list failure becomes an empty host list (`src/rooms/contracts/rpc-shell.ts:20-60`, `src/rooms/settings/server/rpc/preferences.ts:35-64`).
4. `get_agent_inventory` uses explicit project/host ids when given, otherwise falls back to remembered/first visible project and connected/first host. It asks the catalogs for skills and host MCP servers where those ids resolve; inventory groups preserve ready, unavailable, or error status (`src/rooms/contracts/rpc-shell.ts:62-72`, `src/rooms/settings/server/rpc/preferences.ts:66-104`, `packages/contracts/src/schemas.ts:152-156`).
5. `save_globals` runs through serialized KV access and compares `expectedRevision`. A mismatch returns `ok:false` with current revision/defaults; a match parses, stores, and returns the next revision (`src/rooms/contracts/rpc-shell.ts:74-89`, `src/rooms/settings/server/rpc/preferences.ts:106-116`).
6. `save_agent_profile` checks the current source hash, rejects corrupt profiles or hash mismatches with `ok:false`, applies each resource mode, compiles the profile, then stores the override and returns its new hash. Compile failures also return `ok:false` (`src/rooms/contracts/rpc-shell.ts:91-109`, `src/rooms/settings/server/rpc/preferences.ts:117-145`).

| Route branch | Inputs and limits | Result or failure |
|---|---|---|
| Locale | Preference `auto|en|ru`; suggested locale `en|ru`. | Returns resolved locale and preference; extra fields or invalid enums fail strict validation. |
| Inventory | Nullable project/host ids; resource mode `inherit`, `none`, or `selected`. | Each group is `ready`, `unavailable`, or `error`, keeping catalog failure distinct from empty results (`packages/contracts/src/schemas.ts:152-156`). |
| Global defaults | Strict defaults object plus nonnegative `expectedRevision`. | Revision conflict returns `ok:false` with the current snapshot; success increments revision. |
| Agent profile | Lowercase id pattern, prompt 1–32,000 characters, description up to 400, lists up to 64, expected source hash, optional resource modes. | Hash/corrupt/compile failures return `ok:false`; success returns source hash. |

Project and section list errors can reject the handler call; global host-list errors are caught and produce an empty host list (`src/rooms/settings/server/rpc/preferences.ts:35-64`). Inventory groups return `ready`, `unavailable`, or `error`, while global-default revision conflicts and agent-profile hash/compile failures return `ok:false` values (`src/rooms/native-agent/agent-inventory.ts:1-4`, `:33-63`, `src/rooms/settings/server/rpc/preferences.ts:106-145`).

| Variant | Input branch | Result or failure shape |
|---|---|---|
| Locale | `auto`, `en`, or `ru`; suggested locale is `en` or `ru`. | Returns resolved locale and preference. Invalid enum values or extra fields fail strict validation. |
| Resource profile | Resource mode per tools, disallowed tools, skills, and MCP servers is `inherit`, `none`, or `selected`; profile fields have per-field bounds. | Schema accepts a success-shaped response; hash conflict handling is owned by the profile handler. |
| Agent inventory | Project and host ids are nullable; each resource category has a status and optional error. | An unavailable catalog stays distinct from an empty list. |

These distinctions are declared by the schemas; they do not themselves authorize access or decide write conflicts (`src/rooms/contracts/rpc-shell.ts:62-109`, `packages/contracts/src/schemas.ts:152-156`).

### Memory routes and accepted-task maintenance

`createMemoryStage` runs maintenance after an accepted task or when called explicitly. It checks that the caller is the run's PM and that the task belongs to the project/run, then requires a passed acceptance receipt before examining memory settings (`src/rooms/memory/server/memory.ts:26-47`). Existing terminal receipts are returned unchanged; disabled memory or maintenance records a skipped receipt unless a child already exists (`src/rooms/memory/server/memory.ts:61-70`). Otherwise it recovers a child, records a snapshot and spawn claim, validates provider/model/effort/tier, applies helper policy and placement, then spawns the maintainer and observes it (`src/rooms/memory/server/memory.ts:128-182`).

| Maintenance outcome | Condition and state | Evidence |
|---|---|---|
| Skipped | Memory or maintenance disabled and there is no live child. | `src/rooms/memory/server/memory.ts:61-70` |
| Running/observing | Child is live, spawn ownership is held elsewhere, a snapshot is unavailable, or a transient host/event error needs reconciliation. | `src/rooms/memory/server/memory.ts:95-106`, `:151-155`, `:183-209` |
| Failed | Product failure, invalid provider/model settings, empty child output, or a non-transient spawn/processing error. | `src/rooms/memory/server/memory.ts:100-109`, `:157-166`, `:183-212` |
| Passed | Child output parses to candidates, records are stored within configured budgets, and the stage receipt records stored/evicted/superseded ids and audience. | `src/rooms/memory/server/memory.ts:108-126` |

The spawn claim and terminal receipt make maintenance idempotent; a second call returns the saved terminal receipt instead of spawning another child (`src/rooms/memory/server/memory.ts:22-25`, `:61-64`, `:151-155`).

## Modes, variants and failures

| Contract | Inputs and result | Failure handling |
|---|---|---|
| App RPC | Strict Zod schemas; method input and output shape are declared in each `rpc-*` module (`src/rooms/contracts/rpc-shell.ts:8-18`, `src/rooms/contracts/rpc-runs.ts:33-43`, `src/rooms/contracts/rpc-ops.ts:5-109`). | Invalid payloads fail contract validation before the handler result reaches the UI. |
| Jev provider settings | Status by provider, save a key, and test the configured provider (`src/rooms/contracts/rpc-knowledge.ts:189-200`). | Status returns key presence only; saving rejects empty or whitespace-containing keys and test returns a structured failure when no key is available (`src/rooms/secrets/server/rpc/jev.ts:19-48`). |

## Business rules

RPC schemas use strict object validation at method boundaries (`src/rooms/contracts/rpc-shell.ts:8-18`, `src/rooms/contracts/rpc-runs.ts:7-21`, `src/rooms/contracts/rpc-ops.ts:5-109`). The run card's stage and task state values are summarized for UI display; receipt details are fetched through a separate method (`src/rooms/contracts/rpc-runs.ts:7-43`). Jev provider configuration is global, and saving a new key clears the core's cached key so the next Jev call can use it immediately (`src/rooms/secrets/server/rpc/jev.ts:31-38`, `src/rooms/core/server/core.ts:71-72`).

## Public API or commands

`rpcContract` is exported from the contracts room and re-exported by `server.ts` for BB discovery (`src/rooms/contracts/index.ts:15-26`, `server.ts:52-53`). See [Host RPC contract](rpc-callers/host-contract.md) for `hostContract` registration, validation, execution modes, outcomes, and failures; see [Server core construction](rpc-callers/create-core.md) for how `createCore` builds the shared host client and handler context. `runOnHost` wraps `runCommand` and supplies the default host transport deadline (`packages/host-calls/src/run-on-host.ts:8-31`).

`main` in `record_and_guard.py` requires a log path and guard path, otherwise prints usage and returns exit code 2. It reads stdin as JSON, substitutes `{}` on JSON syntax failure, records the unmodified parsed payload and raw/normalized agent markers as one JSONL line, and only adds `agent_type: lane-pilot-pm` to the subprocess payload when the input is a mapping with no agent type and `LANE_PILOT_PM=1` (`scripts/record_and_guard.py:19-41`). It invokes the guard with the current Python executable, JSON stdin, inherited environment plus `AGENT_HOOK_CLIENT=claude`, and returns the child exit code; log-write or process-launch exceptions are not caught (`scripts/record_and_guard.py:42-49`).

See [Handoff message](rpc-callers/handoff-message.md) for `handoffMessage` formatting, its caller, receipt extraction, and failure outcomes.

`runOnHost` forwards a `runCommand` call with `requestedHostId`, command, cwd and command timeout; the same host id is also supplied in call options. An explicit transport timeout wins, otherwise the wrapper waits for command timeout plus five seconds. The returned promise and any host rejection pass through (`packages/host-calls/src/run-on-host.ts:17-31`).

## Gotchas

The RPC contract is a shape contract; authorization and ownership checks remain in handlers. For example, memory maintenance checks PM role, run id, project, task and acceptance receipt before starting (`src/rooms/memory/server/memory.ts:37-47`). Host ids appear in both `runOnHost`'s request and call options because the BB client contract needs both (`packages/host-calls/src/run-on-host.ts:1-5`, `:26-31`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot architecture](architecture.md)
- [Lane Pilot overview](overview.md)
- [Server core construction](rpc-callers/create-core.md)
- [Handoff message](rpc-callers/handoff-message.md)
- [Host RPC contract](rpc-callers/host-contract.md)
- [Run RPC contract](rpc-callers/rpc-runs.md)
- [Workflow RPC contract](rpc-callers/rpc-workflow.md)
- [Session memory RPC](rpc-callers/session-memory-rpc.md)
- [RPC route execution details](rpc-details.md)
