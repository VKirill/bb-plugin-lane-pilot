---
title: Package operation details
type: component
created: 2026-10-14
updated: 2026-11-26
status: active
confidence: high
tags: [rpc, host-calls, handoff]
sources:
  - packages/contracts/src/index.ts
  - src/rooms/contracts/index.ts
  - src/rooms/core/server/rpc-timing.ts
  - packages/host-calls/src/run-on-host.ts
  - packages/handoff/src/messages.ts
---

# Package operation details

TL;DR: Execution and failure behavior of core shared package helpers: `rpcContract` validation composition, `runOnHost` timeout forwarding, and `handoffMessage` rendering.

## Purpose

Describe the execution and failure behavior of selected package APIs summarized in [Packages](packages.md).

## How it works

### `rpcContract`

1. The contracts room imports `rpcShell`, `rpcNative`, `rpcRuns`, `rpcSettings`, `rpcOps`, `rpcKnowledge`, `rpcWorkflow`, `rpcWorkflowExport`, and `rpcWorkflowMap`, spreads each into one `defineRpcContract` call, and exports it as `rpcContract` (`src/rooms/contracts/index.ts`).
2. Composition is unconditional. Each method owns its strict input and output schemas; `rpcContract` does not add a separate route mode or transform a domain result.
3. The module separately exports `hostContract` and shared schemas/types, while `rpcContract` is the single public UI RPC contract of the room (`src/rooms/contracts/index.ts`).

| Condition | Result | Failure behavior |
|---|---|---|
| Valid route payload | Method input is checked against the schema declared in its source map; the contract includes the route's declared output shape. | Handler owns domain work and domain refusal values. |
| Extra or invalid field | Strict route schemas reject undeclared keys, invalid enums, and values outside declared bounds. | Validation fails before the handler returns a result. |
| Handler or transport failure | Contract does not convert a rejection into a domain result. | RPC caller receives the rejection through the registration wrapper (`src/rooms/core/server/rpc-timing.ts`). |

### `runOnHost`

1. `runOnHost(host, args)` takes host id, cwd, command, command timeout and an optional hub transport timeout (`packages/host-calls/src/run-on-host.ts:8-24`).
2. It calls `runCommand` with the host id duplicated as `requestedHostId` in the request and `hostId` in options, and forwards command, cwd and `timeoutSec` (`packages/host-calls/src/run-on-host.ts:26-31`).
3. An explicit `timeoutMs` is used as the transport timeout; otherwise the transport gets command timeout plus five seconds. The function returns the `host.call` promise directly, so a fulfilled host result and a rejected call pass through without translation (`packages/host-calls/src/run-on-host.ts:26-31`).

| Branch | Outcome or failure |
|---|---|
| Explicit transport timeout | Forwards the caller's `timeoutMs`. |
| No transport timeout | Computes `(timeoutSec + 5) * 1000`. |
| Host rejects | Rejection propagates; the wrapper does not catch or translate it. |

### `handoffMessage`

1. `handoffMessage(card)` assembles a recipient prompt in fixed order: handoff identity/title, objective, numbered acceptance criteria, inputs, budget and receipt instructions (`packages/handoff/src/messages.ts:12-37`).
2. Inputs render as `- kind: ref` with an optional note, or `- none`. The budget includes truthy minutes, turns, tokens and deadline values, or `none stated` (`packages/handoff/src/messages.ts:3-16`).
3. The final fenced JSON asks for `done`, `blocked`, or `rejected`, with summary, outputs and evidence. The formatter returns a string and does not parse or validate a recipient response (`packages/handoff/src/messages.ts:31-37`).

| Condition | Output | Failure behavior |
|---|---|---|
| Empty inputs or budget | Emits `- none` or `none stated`. | Not an error. |
| Non-empty card | Includes input details, truthy budget fields and receipt template. | The formatter has no catch or failure result; invalid runtime data can throw during formatting. |

## Public API or commands

`rpcContract` is exported by the contracts room after the route maps are composed (`src/rooms/contracts/index.ts`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Shared packages](packages.md)
