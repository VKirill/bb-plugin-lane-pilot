---
title: Host RPC contract
type: component
created: 2026-10-16
updated: 2026-10-17
status: active
confidence: medium
tags: [rpc, host, contracts]
sources:
  - src/rooms/contracts/host.ts
  - src/rooms/contracts/host/machine.ts
  - src/rooms/core/server/core.ts
  - host.ts
  - packages/host-calls/src/host-jobs.ts
  - packages/host-calls/src/run-on-host.ts
  - src/rooms/contracts/index.ts
---

# Host RPC contract

TL;DR: `hostContract` validates host procedure names, requests, and results across the modular `src/rooms/contracts/host/` family; core routes selected calls through host jobs and leaves other calls direct.

## Purpose

The host contract is the typed boundary between the plugin server and a BB-connected host. `src/rooms/contracts/host.ts` composes `stackHostMethods`, `gitHostMethods`, `docsHostMethods`, `fileHostMethods`, `machineHostMethods`, `jobHostMethods`, `execHostMethods`, and `desktopHostMethods` into `hostContract` (`src/rooms/contracts/host.ts:13-24`), and `src/rooms/contracts/index.ts` exports it separately from the app-facing `rpcContract`.

## How it works

1. Each procedure in `src/rooms/contracts/host/*.ts` uses strict Zod input and output objects. Requests identify the target with `requestedHostId`; BB call options separately carry `hostId` (`packages/host-calls/src/run-on-host.ts:1-14`).
2. The root host entry registers method handlers against the same contract (`host.ts`).
3. `createCore` creates the typed host client and wraps its `call` method. It adds the current schedule abort signal when the caller supplied none, then runs the call inside deploy-drain tracking (`src/rooms/core/server/core.ts:75-95`).
4. Core strips internal options (`job`, `jobKey`, `worktreeOwner`, `cancelOnAbort`) before sending the request (`src/rooms/core/server/core.ts:85`).
5. Core chooses background-job mode when `LANE_PILOT_HOST_JOBS` is not `0` and the method is a declared host job kind (`runSandboxedCommand` requires `job: true` explicitly; `src/rooms/core/server/core.ts:88-90`).
6. The job wrapper reuses a stored job that is still running, or a recent completed result where permitted, otherwise starts a job and polls until terminal state (`packages/host-calls/src/host-jobs.ts`).

| Branch | Inputs and condition | Outcome |
|---|---|---|
| Direct call | Host jobs disabled, method not a job kind, or `runSandboxedCommand` without `job: true`. | The contract method is called directly. |
| Background job | Jobs enabled and method is a job kind; sandboxed command additionally requires `job: true`. | `jobStart` gives a job id, then polling returns the result on `succeeded` (`packages/host-calls/src/host-jobs.ts`). |
| Older host | `jobStart` rejects with an “unknown host method” error. | Wrapper falls back to the direct call; other `jobStart` errors propagate. |
| Job not reusable | Stored job is no longer running and is not a recent reusable completed result. | The wrapper deletes its KV key and starts a new job. |

| Host domain module | Covered procedures |
|---|---|
| `stack`, `git` | Native installation, git ownership base, worktree prepare/snapshot/remove/sync/create, `gitIntegrate`. |
| `docs`, `files`, `exec`, `desktop` | Docs scanning, bounded file reads, sandboxed/host command execution, macOS desktop routines. |
| `machine` | `diskFree`, `listPermitTickets`, `answerPermit`, `readUsageWindows`, `closeBacklogItem`, `whichPrograms`, `prepareWorkerHome`, `writeUsageSnapshot`, `removeWorkerHome`, `vpnAddress`, `writePmSettings` (`src/rooms/contracts/host/machine.ts:4-67`). |
| `jobs` | `jobStart`, `jobStatus`, `jobCancel`. |

## Business rules

Host methods use result enums for domain outcomes such as `not-git`, `invalid-ref`, `dirty`, `conflict`, `busy`, or `failed`; transport and handler errors remain promise rejections (`src/rooms/contracts/host.ts`).

Git paths must be absolute where declared; input objects are strict, so extra fields or invalid branch values fail validation rather than being ignored.

## Public API or commands

`hostContract` is exported by `src/rooms/contracts/index.ts` and consumed by `bb.hosts.experimental_client` (`src/rooms/core/server/core.ts:48`). `runOnHost` wraps `runCommand`, passing `hostId` in both request and options (`packages/host-calls/src/run-on-host.ts:8-31`).

## Gotchas

- Strict request schemas reject extra keys and invalid enum or bound values before a host handler receives the request (`src/rooms/contracts/host/machine.ts`).
- A disposed plugin, aborted caller signal, failed/cancelled/lost job, or elapsed wait deadline rejects the job call (`packages/host-calls/src/host-jobs.ts`).
- `jobKey` scopes reuse for the same logical request. For sandboxed commands, a completed result is reusable only when the caller supplied a key.

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
