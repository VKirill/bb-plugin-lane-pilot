---
title: RPC and host-call contracts
type: component
created: 2026-09-30
updated: 2026-10-11
status: active
confidence: medium
tags: [rpc, contracts, host-api]
sources:
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/contracts/index.ts
  - src/rooms/contracts/host.ts
  - src/rooms/contracts/rpc-shell.ts
  - src/rooms/contracts/rpc-runs.ts
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
---

# RPC and host-call contracts

TL;DR: The contracts room assembles strict UI RPC schemas and a separate host contract; the core registers one implementation object from domain handlers.

## Purpose

Keep BB app-to-server calls and plugin-server-to-host calls typed independently. The app RPC contract is assembled from shell, native, runs, settings, operations, knowledge, workflow, and world contracts (`src/rooms/contracts/index.ts:17-26`).

## How it works

1. `rpcContract` imports the shell, native, runs, settings, operations, knowledge, workflow, and world maps, spreads them into one `defineRpcContract` call, and exports that value as the room's public RPC contract (`src/rooms/contracts/index.ts:1-26`). Composition is unconditional; optional inputs, enums, bounds, and nullable results are declared on each method. For example, shell methods and run-list requests use strict input objects, so undeclared keys and values outside those schemas fail contract validation (`src/rooms/contracts/rpc-shell.ts:8-18`, `src/rooms/contracts/rpc-runs.ts:33-43`).
2. `registerRpc` creates handler maps from the server modules, passing `ctx` and `services` where required and narrower dependencies such as `ctx.db`, `services.council`, or `services.canary` to their owners (`src/rooms/core/server/rpc.ts:4-24`, `:29-49`).
3. It spreads those maps into one handler object, wraps every handler with `timeRpcHandlers`, and calls `ctx.bb.rpc.register(rpcContract, ...)` once (`src/rooms/core/server/rpc.ts:26-51`). It has no feature-gate branch or local catch around registration; a registration error propagates to the caller (`src/rooms/core/server/rpc.ts:27-51`).
4. The timing wrapper awaits each handler and returns its answer unchanged. Rejections are rethrown; `finally` logs elapsed time and distinguishes a refused error from other failures. For successful calls lasting at least 250 ms it also attempts to log serialized answer size; serialization and logging errors are swallowed so they do not change the RPC result (`src/rooms/core/server/rpc-timing.ts:1-2`, `:12-40`).
### Route-family behavior

- `rpcShell` adds schedule contract methods first, then declares locale/preferences, project and section lookup, global settings, agent inventory and profile writes. Locale accepts `auto`, `en`, or `ru`; saving globals carries an expected revision; profile writes validate IDs, prompt length, resource limits and an expected source hash (`src/rooms/contracts/rpc-shell.ts:1-18`, `:20-73`, `:74-109`). These contracts declare input/output shapes; handlers decide conflict outcomes.
- `rpcRuns` uses explicit result variants: `get_run_card` and `get_stage_result` can return no record; list requests require offset and cap `limit` at 200; the screen request may include section and run limits, and its writer binding exposes resolved, ambiguous, setup-required, offline and catalog-unavailable states (`src/rooms/contracts/rpc-runs.ts:7-21`, `:33-43`, `:67-99`).
- `rpcKnowledge` groups council reads and owner messages, rule and memory operations, docs status, usage synchronization/rebuild, secret issuance, Jev provider settings, and workspace-provider status/reset. Its schemas encode modes such as docs `auto|on|off` and `nightly|weekly|paused`, usage ranges, and a rebuild result that is either started with backup counts or refused as already running (`src/rooms/contracts/rpc-knowledge.ts:17-60`, `:90-131`, `:133-177`, `:179-210`).
- `rpcWorkflow` distinguishes manual and Telegram starts, exposes explicit not-found and preflight result shapes, and separates stubbed dry runs and test runs from live runs. Draft creation selects `edit` or `duplicate`; patch and restore accept optional expected versions; architect start returns whether it reused a living thread (`src/rooms/contracts/rpc-workflow.ts:6-52`, `:54-105`).
- `rpcOps` groups run controls, statistics, deployment drain, self-repair, canary, and stack management. Stack install/connect require `confirmExternalOps`; rollback accepts an optional absolute snapshot path. Several operation outputs are `unknown` at the shared contract, so their success and refusal shapes belong to the implementing room (`src/rooms/contracts/rpc-ops.ts:5-109`).

## Modes, variants and failures

| Contract | Inputs and result | Failure handling |
|---|---|---|
| App RPC | Strict Zod schemas; method input and output shape are declared in each `rpc-*` module (`src/rooms/contracts/rpc-shell.ts:8-18`, `src/rooms/contracts/rpc-runs.ts:33-43`, `src/rooms/contracts/rpc-ops.ts:5-109`). | Invalid payloads fail contract validation before the handler result reaches the UI. |
| Host RPC | Host methods include `requestedHostId`; output is checked against typed schemas (`src/rooms/contracts/host.ts:6-15`). | Host call errors propagate to the calling room or are converted there into domain result states. |
| Session memory | Path lookup, write, search, core listing and lesson proposal (`src/rooms/memory/server/session-memory.ts:15-67`). | Writes return explicit disabled, parse, duplicate/corroboration or storage outcomes (`:32-48`). |
| Jev provider settings | Status by provider, save a key, and test the configured provider (`src/rooms/contracts/rpc-knowledge.ts:189-200`). | Status returns key presence only; saving rejects empty or whitespace-containing keys and test returns a structured failure when no key is available (`src/rooms/secrets/server/rpc/jev.ts:19-48`). |
| Handoff message | Recipient receives objective, acceptance criteria, inputs, budget and a fixed JSON receipt template (`packages/handoff/src/messages.ts:12-37`). | Invalid JSON blocks are skipped; no matching card id returns null (`packages/handoff/src/messages.ts:40-55`). |

## Business rules

RPC schemas use strict object validation at method boundaries (`src/rooms/contracts/rpc-shell.ts:8-18`, `src/rooms/contracts/rpc-runs.ts:7-21`, `src/rooms/contracts/rpc-ops.ts:5-109`). The run card's stage and task state values are summarized for UI display; receipt details are fetched through a separate method (`src/rooms/contracts/rpc-runs.ts:7-43`). Session memory records are written for the `subagent` audience (`src/rooms/memory/server/session-memory.ts:38-45`). Jev provider configuration is global, and saving a new key clears the core's cached key so the next Jev call can use it immediately (`src/rooms/secrets/server/rpc/jev.ts:31-38`, `src/rooms/core/server/core.ts:71-72`).

## Public API or commands

`rpcContract` is exported from the contracts room and re-exported by `server.ts` for BB discovery (`src/rooms/contracts/index.ts:15-26`, `server.ts:52-53`). `hostContract` is the client contract for host procedures (`src/rooms/contracts/index.ts:15-16`, `src/rooms/contracts/host.ts:6-15`). `runOnHost` wraps `runCommand` and supplies the default host transport deadline (`packages/host-calls/src/run-on-host.ts:8-31`).

`main` in `record_and_guard.py` requires a log path and guard path, otherwise prints usage and returns exit code 2. It reads stdin as JSON, substitutes `{}` on JSON syntax failure, records the unmodified parsed payload and raw/normalized agent markers as one JSONL line, and only adds `agent_type: lane-pilot-pm` to the subprocess payload when the input is a mapping with no agent type and `LANE_PILOT_PM=1` (`scripts/record_and_guard.py:19-41`). It invokes the guard with the current Python executable, JSON stdin, inherited environment plus `AGENT_HOOK_CLIENT=claude`, and returns the child exit code; log-write or process-launch exceptions are not caught (`scripts/record_and_guard.py:42-49`).

`handoffMessage` renders the card id, sender and title, objective, numbered acceptance lines, inputs, budget and fixed JSON receipt instructions in that order. Empty inputs render as `- none`; an empty budget renders as `none stated`; the formatter itself has no error-result branch (`packages/handoff/src/messages.ts:3-9`, `:12-37`). Receipt extraction scans fenced JSON blocks from newest to oldest, returns the matching card's JSON without the `handoff` key, skips malformed blocks, and returns `null` when none matches (`packages/handoff/src/messages.ts:40-55`).

`runOnHost` forwards a `runCommand` call with `requestedHostId`, command, cwd and command timeout; the same host id is also supplied in call options. An explicit transport timeout wins, otherwise the wrapper waits for command timeout plus five seconds. The returned promise and any host rejection pass through (`packages/host-calls/src/run-on-host.ts:17-31`).

## Gotchas

The RPC contract is a shape contract; authorization and ownership checks remain in handlers. For example, memory maintenance checks PM role, run id, project, task and acceptance receipt before starting (`src/rooms/memory/server/memory.ts:37-47`). Host ids appear in both `runOnHost`'s request and call options because the BB client contract needs both (`packages/host-calls/src/run-on-host.ts:1-5`, `:26-31`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot architecture](architecture.md)
- [Lane Pilot overview](overview.md)
