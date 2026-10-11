---
title: Native agent activation and dispatch
type: component
created: 2026-10-10
updated: 2026-10-11
status: active
confidence: high
tags: [native-agent, composer, activation]
sources:
  - src/rooms/native-agent/ui/composer-enable.tsx
  - src/rooms/native-agent/server/activation.ts
  - src/rooms/core/server/native-wiring.ts
  - src/rooms/contracts/rpc-native.ts
  - src/rooms/contracts/host.ts
  - src/rooms/native-agent/activation.ts
  - src/rooms/native-agent/composer-selection.ts
  - src/rooms/native-agent/server/native-profile.ts
  - src/rooms/anamnesis/contract.ts
  - src/rooms/core/server/core.ts
---

# Native agent activation and dispatch

TL;DR: The composer action prepares a Lane Pilot agent selection for a new project chat, while the server validates the project and environment before creating a PM run.

## Purpose

Enable a new BB composer thread as a Lane Pilot PM session and route its first dispatch through the selected native agent (`src/rooms/native-agent/ui/composer-enable.tsx:49-60`, `src/rooms/native-agent/server/activation.ts:63-80`).

## How it works

1. `EnableLanePilotAction` requests activation context for the selected project, then disables activation while pending, without a project, without a writer binding, or without a usable compiled main agent (`src/rooms/native-agent/ui/composer-enable.tsx:71-94`).
2. On enable, the UI requires `experimental_vkSetDispatchData`, tries Claude Opus 5.5 with 1M context before the standard model, and requires BB to confirm the selected provider and model (`src/rooms/native-agent/ui/composer-enable.tsx:96-115`).
3. The UI asks `prepare_native_session` for the chosen profile, attaches its returned token as dispatch data, and starts native installation asynchronously when a host is selected (`src/rooms/native-agent/ui/composer-enable.tsx:112-123`).
4. `createActivation` validates a supplied composer environment snapshot. Reused environments must exist and match the project, host, and path; host and provisioned environments must be associated with a project source (`src/rooms/native-agent/server/activation.ts:24-60`).
5. Activation rejects a writer thread, requires project configuration, and uses the native snapshot when it is ready. Without one, it detects the configured workspace and checks for a compatible Lane Stack engine (`src/rooms/native-agent/server/activation.ts:63-90`).
6. `storeNativeSelection` compiles the requested owned or stock profile, rejects corrupt or unknown profiles, prepares an installed or session-override record, optionally attaches its parent run, and stores it in BB KV under the generated selection token (`src/rooms/native-agent/server/native-profile.ts:12-30`).
7. `mountNativeWiring` registers BB hooks and providers, then installs the stream retry watcher using the shared `bb`, database and native host from `ServerCore` (`src/rooms/core/server/native-wiring.ts:10-12`).
8. Its mention provider looks up `native-selection:<token>` in BB KV, logs and throws a reselect message when no row exists, parses a found row with `nativeSelectionSchema`, then returns `mentionContext(parsed)` (`src/rooms/core/server/native-wiring.ts:13-26`).
9. It routes `message.dispatch` to `handleNativeDispatch`, contributes the native environment to Claude Code, and mounts the OpenCode-minimal and BB shims (`src/rooms/core/server/native-wiring.ts:29-34`). These registrations are unconditional within this mount function.
10. It attaches stream retry with event access, thread retry, disposed-state check and warning logger. Failure detail reads the latest 50 thread-watch events and returns `null` if event listing fails (`src/rooms/core/server/native-wiring.ts:35-45`).
11. The retry watcher considers a thread unowned when its attempt is already cancel-requested or canceled; otherwise role/run metadata marks it owned, with `native-thread:<threadId>` KV as fallback (`src/rooms/core/server/native-wiring.ts:46-57`).

## Modes and branches

| Input state | Behavior | Failure result |
|---|---|---|
| New thread with project and usable binding | Show the enable action and prepare selected agent dispatch data (`src/rooms/native-agent/ui/composer-enable.tsx:45-60`, `:84-94`). | Pending, missing project, missing binding, or unavailable compiled agent disables activation (`src/rooms/native-agent/ui/composer-enable.tsx:37-42`, `:84-94`). |
| Existing environment reuse | Verify existence and project, host, and path consistency (`src/rooms/native-agent/server/activation.ts:29-38`). | Throws a specific environment mismatch code. |
| Existing host environment | Require a host id and verify it belongs to a configured project source (`src/rooms/native-agent/server/activation.ts:44-49`). | Throws when host is missing or outside the project. |
| Provider-provisioned environment | Verify selected host association and provider availability (`src/rooms/native-agent/server/activation.ts:51-60`). | Throws on unknown provider or project-host mismatch. |
| Stored native profile selection | Compile the requested profile and persist a prepared session record keyed by its token (`src/rooms/native-agent/server/native-profile.ts:12-30`). | Corrupt stored profiles and IDs that match neither an owned nor stock profile throw explicit errors (`src/rooms/native-agent/server/native-profile.ts:14-20`). |
| Mention selection token | Read and parse the stored session record before building mention context (`src/rooms/core/server/native-wiring.ts:13-25`). | Missing tokens log a debug trace and throw an instruction to choose the profile again; malformed records fail schema parsing (`src/rooms/core/server/native-wiring.ts:18-24`). |
| Stream retry ownership | Retry handling receives failure details and an ownership predicate (`src/rooms/core/server/native-wiring.ts:35-57`). | Canceled attempts are excluded; event-list failure produces no failure detail; role/run metadata or the native-thread KV marker identifies owned threads (`src/rooms/core/server/native-wiring.ts:40-57`). |
| No ready native snapshot | Detect configured PM workspace and test compatible installed engine (`src/rooms/native-agent/server/activation.ts:72-90`). | Throws if project setup is missing or no compatible engine exists. |

## Business rules

- A writer thread cannot become a PM thread (`src/rooms/native-agent/server/activation.ts:63-68`).
- A reused environment cannot silently change its project, host, or path (`src/rooms/native-agent/server/activation.ts:29-38`).
- The composer selection is attached through BB's experimental dispatch-data hook; without it the UI displays an upgrade error (`src/rooms/native-agent/ui/composer-enable.tsx:101-115`).

## Public API or commands

The activation UI calls the typed `activation_context`, `prepare_native_session`, and `native_install_start` RPC methods (`src/rooms/native-agent/ui/composer-enable.tsx:71-80`, `:112-115`). `storeNativeSelection` prepares the token record used by native session selection (`src/rooms/native-agent/server/native-profile.ts:12-30`).

`hostContract` is a schema map for plugin-to-host procedures. Its methods require `requestedHostId`; filesystem paths are absolute where declared, and operation names, limits and output variants are constrained by Zod (`src/rooms/contracts/host.ts:6-30`, `:31-50`, `:53-71`). The groups cover native install actions, Git ownership and worktree lifecycle, long-running host jobs, stability drills, Anamnesis methods, disk space, and docs probes (`src/rooms/contracts/host.ts:6-90`).

| Host contract operation | Mode or outcome encoded by the contract | Invalid or failed call outcome |
|---|---|---|
| `nativeInstall` | Actions are `install`, `enable`, `disable`, `remove`, or `status`; result status is `absent`, `prepared`, `enabled`, or `disabled` (`src/rooms/contracts/host.ts:6-10`). | An input action outside the enum or malformed host id fails schema validation. |
| `gitOwnershipBase` | Result status is `ready`, `not-git`, `invalid-ref`, or `failed`; branch and commit fields may be null (`src/rooms/contracts/host.ts:11-14`). | Git failures are represented in the result status and `reason`; malformed absolute paths fail validation. |
| Worktree snapshot, sync, create and integrate | Results distinguish clean/saved/missing/failed; synced/up-to-date/dirty/conflict/failed; ready/failed; and merged/up-to-date/conflict/failed/busy respectively (`src/rooms/contracts/host.ts:19-30`, `:57-71`). | The schema reports each operation's reason and conflicts where declared; the contract does not retry or convert these statuses. |
| Host jobs | Start accepts a job kind, input object and 10–10,800 second deadline; status is `running`, `succeeded`, `failed`, `cancelled`, or `lost`; cancel returns a boolean (`src/rooms/contracts/host.ts:31-47`). | Invalid kinds, deadlines or job references fail contract validation; runtime failure is represented by the job state and error. |

The contract declares shapes, not host-side recovery. `createCore` binds it through BB's experimental host client; callers receive a rejected call if the host transport rejects before a declared output is returned (`src/rooms/core/server/core.ts:48-49`).

## Gotchas

A successful UI preparation attaches a token to the next submission; submission clears the pending UI selection (`src/rooms/native-agent/ui/composer-enable.tsx:112-128`). Environment validation is performed again server-side, so a stale composer selection can still fail during activation (`src/rooms/native-agent/server/activation.ts:24-60`).
