---
title: Native agent activation and dispatch
type: component
created: 2026-10-10
updated: 2026-10-14
status: active
confidence: medium
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
  - src/rooms/native-agent/server/helper-bb-shim.ts
  - src/rooms/host-worker/host-handlers.ts
  - src/rooms/anamnesis/contract.ts
  - src/rooms/core/server/core.ts
  - src/rooms/contracts/index.ts
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
9. It routes `message.dispatch` to `handleNativeDispatch`, contributes the native environment to Claude Code, and mounts the BB shims (`src/rooms/core/server/native-wiring.ts:28-31`). These registrations are unconditional within this mount function.
10. It attaches stream retry with event access, thread retry, disposed-state check and warning logger. Failure detail reads the latest 50 thread-watch events and returns `null` if event listing fails (`src/rooms/core/server/native-wiring.ts:35-45`).
11. The retry watcher considers a thread unowned when its attempt is already cancel-requested or canceled; otherwise role/run metadata marks it owned, with `native-thread:<threadId>` KV as fallback (`src/rooms/core/server/native-wiring.ts:46-57`).
12. Provider environment contributors prepare BB guard wrappers for supported helper threads. `mountBbShim` registers Codex, OpenCode v2 (`opencode2`) and Cursor (`src/rooms/native-agent/server/helper-bb-shim.ts:18`, `:79-82`).

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

The helper environment branch also depends on the provider and thread role:

| Provider thread | Environment added | Failure behavior |
|---|---|---|
| Codex or Cursor helper with role metadata other than `pm` | Add `LANE_PILOT_ROLE`; host-prepared `PATH` puts `bb`, `ssh`, `scp`, and `sftp` behind guard wrappers (`src/rooms/native-agent/server/helper-bb-shim.ts:62-80`). | An unknown `prepareBbShim` host method logs a warning and starts with the role marker but no wrappers; another host error rejects contribution (`src/rooms/native-agent/server/helper-bb-shim.ts:44-56`). |
| OpenCode helper | The same marker and wrapper path; the `opencode2` provider sets them as the session's shell environment, since one OpenCode v2 service serves every session (`src/rooms/native-agent/server/helper-bb-shim.ts:5-18`). | A wrapper preparation error rejects contribution (`src/rooms/native-agent/server/helper-bb-shim.ts:51-57`). |
| PM or owner thread | No BB shim variables are contributed (`src/rooms/native-agent/server/helper-bb-shim.ts:63-75`). | If plugin role metadata cannot be read, the contributor logs and returns no variables (`src/rooms/native-agent/server/helper-bb-shim.ts:64-68`). |

## Business rules

- A writer thread cannot become a PM thread (`src/rooms/native-agent/server/activation.ts:63-68`).
- A reused environment cannot silently change its project, host, or path (`src/rooms/native-agent/server/activation.ts:29-38`).
- The composer selection is attached through BB's experimental dispatch-data hook; without it the UI displays an upgrade error (`src/rooms/native-agent/ui/composer-enable.tsx:101-115`).

## Public API or commands

The activation UI calls the typed `activation_context`, `prepare_native_session`, and `native_install_start` RPC methods (`src/rooms/native-agent/ui/composer-enable.tsx:71-80`, `:112-115`). `storeNativeSelection` prepares the token record used by native session selection (`src/rooms/native-agent/server/native-profile.ts:12-30`).

The host entry registers matching implementations for the host worker (`src/rooms/host-worker/host-handlers.ts:1-31`).

## Runtime contracts and core

### `hostContract`

1. The contracts room exports `hostContract` separately from the app `rpcContract`; `hostContract` passes one method map to `defineRpcContract` (`src/rooms/contracts/index.ts:11-16`, `src/rooms/contracts/host.ts:6`).
2. Each host operation declares strict input/output objects. Inputs carry `requestedHostId`; declared absolute paths must begin with `/`, names and commands have bounds, and enum fields define accepted actions and result states (`src/rooms/contracts/host.ts:7-13`, `:15-46`).
3. The map includes native install, Git ownership/worktree actions, jobs, stability, Anamnesis methods, disk, integrate, docs and provider checks. `anamnesisHostMethods` is spread into the contract (`src/rooms/contracts/host.ts:6-72`).
4. `gitIntegrate` accepts required host/base/worktree/message fields, optional committed-only/bookkeeping options, optional `ownsPaths`, and optional bounded replay-check commands; output distinguishes merged/up-to-date/conflict/failed/busy and may carry checks/rebuild results (`src/rooms/contracts/host.ts:61-71`).
5. A contract rejection remains a call failure; a valid operation can return its declared state, reason, conflicts, or job status. The schema does not retry or repair host operations (`src/rooms/contracts/host.ts:11-13`, `:27-46`, `:61-71`).

| Procedure branch | Inputs and results | Failure behavior |
|---|---|---|
| Native install | Action `install`, `enable`, `disable`, `remove`, or `status`; result is absent/prepared/enabled/disabled. | Invalid action/host id fails validation. |
| Git worktree | Snapshot, remove, sync, create, integrate; result enums carry clean/saved/missing, synced/up-to-date/dirty/conflict/failed, ready/failed, or merge statuses. | Operation failures are domain results with reason/conflict fields where declared. |
| Git integrate extensions | Optional ownership patterns, bookkeeping paths, and 1–20 sandbox replay commands with per-command timeouts bounded in schema. | Invalid bounds/paths reject validation; returned checks contain exit code/stdout/stderr. |
| Host job | Start uses a declared kind, input record, 10-second minimum and configured maximum deadline; status and cancel address a job reference. | Runtime state includes running/succeeded/failed/cancelled/lost; transport rejection propagates. |

### `createCore`

1. `createCore(bb, db)` initializes a mutable disposed flag and registers disposal to set it. It wraps available BB log methods with secret redaction, installs illegal-transition logging, creates realtime notifications and helper signals, and registers cleanup for both (`src/rooms/core/server/core.ts:31-47`).
2. It creates the owner-ask helper and BB experimental host client using `hostContract` (`src/rooms/core/server/core.ts:45-49`).
3. Its Jev endpoint reads the global chosen provider setting and Env Catalog key through a ten-minute cache. Catalog RPC failures become missing keys; if the chosen non-TypeSafe provider has no key, a TypeSafe key is tried. It logs provider/key-presence changes and installs Jev with database receipts; the cache can be explicitly cleared after a key change (`src/rooms/core/server/core.ts:51-82`).
4. It binds deploy drain and creates host jobs. The wrapped host call adds a schedule abort signal when the caller has none, runs under the drain, injects Jev credentials for named Jev methods, and uses host jobs for eligible methods unless jobs are disabled; `runSandboxedCommand` needs explicit job mode. Other calls go directly to the raw host client (`src/rooms/core/server/core.ts:83-108`).
5. It builds a native installer whose support flag follows BB's lifecycle capability, exposes a native host wrapper that ensures installation before `prepareNativeClaude`, and defines serialized KV, agent/settings, screen writer-binding, coexistence, and run/workspace helpers (`src/rooms/core/server/core.ts:122-183`).
6. The remaining helpers compute task workspace binding, runtime settings, run policies, native run configuration, Project Folders section scopes, and current config. `configForRun` selects native configuration for CLI runs and stored prototype configuration otherwise (`src/rooms/core/server/core.ts:194-217`, `:260-320`, `:323-373`).
7. It creates secrets and the Jev output guard, then returns the SDK/database, state, wrapped host, drain, installers, and helper functions as one shared context (`src/rooms/core/server/core.ts:375-384`).

| Mode or condition | Behavior | Failure or fallback |
|---|---|---|
| Env Catalog available | Selected provider key is cached for ten minutes and injected into Jev host calls. | Catalog RPC errors are caught and treated as missing key. |
| Chosen provider lacks a key | Uses TypeSafe key if present; endpoint may have no key if neither is available. | Jev call proceeds without injected credentials and uses downstream client behavior. |
| Host job eligible | Uses background job wrapper unless `LANE_PILOT_HOST_JOBS=0`; sandbox command needs `job:true`. | Raw/host job call errors propagate through the call wrapper. |
| Schedule run | Adds the active schedule signal if caller did not supply a signal. | Drain wrapper sees that signal while call runs. |
| CLI run config | Uses run-bound host/workspace and current effective writer settings. | Missing host/workspace returns null; missing writer provider/model throws a setup error. |
| Project Folders sections | Lists sections through plugin RPC and derives deepest matching folder scopes. | Missing RPC or list failure returns no sections. |

`createCore` is the shared dependency object for server rooms; host contract shapes remain separate from app RPC shapes (`src/rooms/core/server/core.ts:31-49`, `src/rooms/contracts/index.ts:11-26`). A native CLI run takes host, workspace, and writer model from run binding/current settings rather than stale prototype configuration (`src/rooms/core/server/core.ts:306-320`, `:370-373`).

## Gotchas

A successful UI preparation attaches a token to the next submission; submission clears the pending UI selection (`src/rooms/native-agent/ui/composer-enable.tsx:112-128`). Environment validation is performed again server-side, so a stale composer selection can still fail during activation (`src/rooms/native-agent/server/activation.ts:24-60`). Core initialization registers disposal callbacks before it returns; host transport errors remain rejections unless a specific handler converts them into a domain state (`src/rooms/core/server/core.ts:31-47`, `:83-108`, `src/rooms/contracts/host.ts:6-13`).
