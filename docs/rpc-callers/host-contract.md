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
  - src/rooms/core/server/core.ts
  - host.ts
  - src/rooms/anamnesis/contract.ts
  - packages/host-calls/src/host-jobs.ts
  - packages/host-calls/src/run-on-host.ts
  - src/rooms/contracts/index.ts
---

# Host RPC contract

TL;DR: `hostContract` validates host procedure names, requests, and results; core routes selected calls through host jobs and leaves other calls direct.

## Purpose

The host contract is the typed boundary between the plugin server and a BB-connected host. `src/rooms/contracts/index.ts` exports it separately from the app-facing `rpcContract` (`src/rooms/contracts/index.ts:11-18`).

## How it works

1. The contract declares each host procedure using strict Zod input and output objects. Requests identify the target with `requestedHostId`; BB call options separately carry `hostId` (`src/rooms/contracts/host.ts:6-15`, `packages/host-calls/src/run-on-host.ts:1-14`).
2. The root host entry registers method handlers against the same contract. Jev-sensitive handlers are wrapped to take the provider and key from the request before calling the implementation (`host.ts:72-87`).
3. `createCore` creates the typed host client and wraps its `call` method. It adds the current schedule abort signal when the caller supplied none, then runs the call inside deploy-drain tracking (`src/rooms/core/server/core.ts:98-117`).
4. Core removes its private `job` and `jobKey` options before sending the request. It attaches cached Jev provider credentials only for methods in `JEV_METHODS`; a missing credential leaves the input unchanged (`src/rooms/core/server/core.ts:50-53`, `:109-116`).
5. Core chooses background-job mode when `LANE_PILOT_HOST_JOBS` is not `0` and the method is a declared host job kind. `runSandboxedCommand` is an exception: it uses a job only when the caller sets `job: true`; all other calls use the direct host call (`src/rooms/core/server/core.ts:114-117`).
6. The job wrapper reuses a stored job that is still running, or a recent succeeded/failed result where the method permits reusing completed work. Otherwise it removes the old key and starts a job, then polls until the host returns a terminal state (`packages/host-calls/src/host-jobs.ts:40-69`, `:76-91`).

| Branch | Inputs and condition | Outcome |
|---|---|---|
| Direct call | Host jobs disabled, method not a job kind, or `runSandboxedCommand` without `job: true`. | The contract method is called directly; for Jev methods core may add `jevApiKey` and `jevProvider` (`src/rooms/core/server/core.ts:109-117`). |
| Background job | Jobs enabled and method is a job kind; sandboxed command additionally requires `job: true`. | `jobStart` gives a job id, then polling returns the result on `succeeded` (`src/rooms/contracts/host.ts:31-46`, `packages/host-calls/src/host-jobs.ts:59-82`). |
| Older host | `jobStart` rejects with an “unknown host method” error. | Wrapper falls back to the direct call; other `jobStart` errors propagate (`packages/host-calls/src/host-jobs.ts:59-66`). |
| Job not reusable | Stored job is no longer running and is not a recent reusable completed result. | The wrapper deletes its KV key and starts a new job (`packages/host-calls/src/host-jobs.ts:50-68`). |

| Contract procedure | Inputs, branches and declared results |
|---|---|
| `nativeInstall` | Input selects install, enable, disable, remove, or status. Output carries absent, prepared, enabled, or disabled plus source hash and owned/preserved file counts (`src/rooms/contracts/host.ts:7-10`). |
| `gitOwnershipBase` | Input requires absolute project cwd and optional 1–240 character base ref. Output is ready, not-git, invalid-ref, or failed with nullable branch/head/base hashes and reason (`src/rooms/contracts/host.ts:11-14`). |
| Worktree prepare, snapshot, remove, sync, create | Inputs require absolute paths; snapshot/create names match the ASCII 1–120 character pattern; sync optionally keeps conflicts. Outputs include linked files, clean/saved/missing/failed snapshot, remove boolean, synced/up-to-date/dirty/conflict/failed sync, or ready/failed create (`src/rooms/contracts/host.ts:15-29`, `:57-59`). |
| `jobStart`, `jobStatus`, `jobCancel` | Start accepts a declared job kind, timeout from 10 seconds through `HOST_JOB_MAX_SEC`, and optional 1–200 character key. Status returns running, succeeded, failed, cancelled, or lost with progress and optional result; cancel returns a boolean (`src/rooms/contracts/host.ts:31-46`). |
| `stabilityDrill`, `anamnesis`, `diskFree` | Drill returns named checks with booleans and nullable detail; Anamnesis uses its request schema and unknown response; disk free requires an absolute path and returns nonnegative byte counts (`src/rooms/contracts/host.ts:48-55`, `src/rooms/anamnesis/contract.ts:11-16`). |
| `gitIntegrate` | Requires absolute base/worktree paths and a 1–500 character message. Optional replay checks choose auto, macOS Seatbelt, or Linux bubblewrap and contain 1–20 commands with 1–7,200 second timeouts. Output is merged, up-to-date, conflict, failed, or busy and may include check/rebuild results (`src/rooms/contracts/host.ts:61-71`). |

Procedures use strict input objects and strict output objects where a structured result is declared; the spread Anamnesis response is `unknown`. Malformed declared shapes fail contract validation, while domain outcomes listed above are returned in the declared result (`src/rooms/contracts/host.ts:6-71`, `src/rooms/anamnesis/contract.ts:11-16`).

## Business rules

Host methods use result enums for domain outcomes such as `not-git`, `invalid-ref`, `dirty`, `conflict`, `busy`, or `failed`; transport and handler errors remain promise rejections (`src/rooms/contracts/host.ts:11-29`, `:57-71`). Job timeout is bounded by the contract's `HOST_JOB_MAX_SEC`; the wrapper also stops waiting at that cap (`src/rooms/contracts/host.ts:31-42`, `packages/host-calls/src/host-jobs.ts:47-49`).

Git paths must be absolute where declared; worktree snapshot/create names match a 1–120 character ASCII name pattern. Input objects are strict, so an extra field or invalid branch value fails validation rather than being ignored (`src/rooms/contracts/host.ts:11-29`, `:57-59`).

## Public API or commands

`hostContract` is exported by `@lane-pilot/contracts`' room entry and consumed by `bb.hosts.experimental_client` (`src/rooms/contracts/index.ts:15-18`, `src/rooms/core/server/core.ts:48-49`). `runOnHost` is the typed helper for `runCommand`; it passes the host id in both request and options and defaults transport wait to command timeout plus five seconds (`packages/host-calls/src/run-on-host.ts:8-31`).

## Gotchas

- Strict request schemas reject extra keys and invalid enum or bound values before a host handler receives the request (`src/rooms/contracts/host.ts:6-15`, `:31-46`).
- A disposed plugin, an aborted caller signal, failed/cancelled/lost job, or elapsed wait deadline rejects the job call. Timeout sends best-effort cancellation and deletes the stored job key; abort stops polling and leaves the host job running for a retry (`packages/host-calls/src/host-jobs.ts:73-88`).
- `jobKey` scopes reuse for the same logical request. For sandboxed commands, a completed result is reusable only when the caller supplied a key (`packages/host-calls/src/host-jobs.ts:42-56`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
