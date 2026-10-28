---
title: Native agent activation and dispatch
type: component
created: 2026-10-10
updated: 2026-10-28
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
  - src/rooms/native-agent/native-dispatch.ts
  - src/rooms/native-agent/native-session.ts
  - src/rooms/native-agent/native-run.ts
  - src/rooms/host-worker/index.ts
  - src/rooms/host-worker/host-handlers.ts
  - src/rooms/anamnesis/contract.ts
  - src/rooms/core/server/core.ts
  - src/rooms/contracts/index.ts
  - src/rooms/core/server/rpc.ts
  - src/rooms/core/server/rpc-timing.ts
  - src/rooms/contracts/rpc-ops.ts
---

# Native agent activation and dispatch

TL;DR: The composer action prepares a Lane Pilot agent selection for a new project chat, while the server validates the project and environment before creating a PM run.

## Purpose

Enable a new BB composer thread as a Lane Pilot PM session and route its first dispatch through the selected native agent. The PM prompt (`src/rooms/native-agent/native-agent-overlay.ts`, copied to `bundled-agents.json` by `scripts/sync-bundled-prompts.ts`) says that every piece of work runs as a graph and that the PM chat is the door: it talks to the owner, passes his words into the machine (phases, `lane_pilot_dispatch_writer`, `lane_pilot_route`, `lane_pilot_run_workflow`), reads the phase book and the run results, and ships. The tools `lane_pilot_errand`, `lane_pilot_specialist`, `lane_pilot_browser`, `lane_pilot_browser_qa` and `lane_pilot_council_start` start the graphs `errand`, `specialist`, `browser-step`, `lp.browser-qa` and `council` (`src/rooms/native-agent/ui/composer-enable.tsx:49-60`, `src/rooms/native-agent/server/activation.ts:63-80`).

## How it works

1. `EnableLanePilotAction` loads saved locale preference, reads an existing chat's agent state when opened from a thread, and requests `activation_context` for the selected project. For the new-thread mention flow, `activationDisabledPredicate` receives pending state and project identity/count; `composerButtonDisabled` disables only while pending, and `startBlocked` prevents preparation for any returned block (`src/rooms/native-agent/ui/composer-enable.tsx:58-80`, `:83-124`, `src/rooms/native-agent/activation.ts:26-44`).
2. On a new thread, `prepare` requires BB's dispatch-data hook, then tries Claude Code `claude-opus-5-5[1m]` followed by `claude-opus-5-5`; it accepts a selection only when BB returns the requested provider and model. Existing chats instead call `switch_chat_agent` (`src/rooms/native-agent/ui/composer-enable.tsx:126-148`).
3. For a new thread, the UI calls `prepare_native_session`, attaches the returned token, starts `native_install_start` without awaiting it when a host is selected, and updates its pending and selected-agent state. Errors are shown in the UI and `pending` is cleared in `finally` (`src/rooms/native-agent/ui/composer-enable.tsx:150-160`).
4. `createActivation` validates a supplied composer environment snapshot. Reused environments must exist and match the project, host, and path; host and provisioned environments must be associated with a project source (`src/rooms/native-agent/server/activation.ts:24-60`).
5. Activation rejects a writer thread, requires project configuration, and uses the native snapshot when it is ready. Without one, it detects the configured workspace and checks for a compatible Lane Stack engine (`src/rooms/native-agent/server/activation.ts:63-90`).
6. `storeNativeSelection` compiles the requested owned or stock profile, rejects corrupt or unknown profiles, prepares an installed or session-override record, optionally attaches its parent run, and stores it in BB KV under the generated selection token (`src/rooms/native-agent/server/native-profile.ts:12-30`).
7. `mountNativeWiring` registers BB hooks and providers, then installs the stream retry watcher using the shared `bb`, database and native host from `ServerCore` (`src/rooms/core/server/native-wiring.ts:10-12`).
8. Its mention provider looks up `native-selection:<token>` in BB KV, logs and throws a reselect message when no row exists, parses a found row with `nativeSelectionSchema`, then returns `mentionContext(parsed)` (`src/rooms/core/server/native-wiring.ts:13-26`).
9. It routes `message.dispatch` to `handleNativeDispatch`, contributes the native environment to Claude Code, and mounts the BB shims (`src/rooms/core/server/native-wiring.ts:28-31`). These registrations are unconditional within this mount function.
10. It attaches stream retry with event access, thread retry, disposed-state check and warning logger. Failure detail reads the latest 50 thread-watch events and returns `null` if event listing fails (`src/rooms/core/server/native-wiring.ts:35-45`).
11. The retry watcher considers a thread unowned when its attempt is already cancel-requested or canceled; otherwise role/run metadata marks it owned, with `native-thread:<threadId>` KV as fallback (`src/rooms/core/server/native-wiring.ts:46-57`).
12. Provider environment contributors prepare BB guard wrappers for supported helper threads. `mountBbShim` registers Codex, OpenCode v2 (`opencode2`) and Cursor (`src/rooms/native-agent/server/helper-bb-shim.ts:18`, `:79-82`).
13. `handleNativeDispatch` combines hidden submission data and profile markers, resolves an existing thread binding or same-project handoff profile, and lets ordinary chats proceed without a native selection (`src/rooms/native-agent/native-dispatch.ts:185-230`).
14. A selected profile must use Claude Code, match the current project, resolve a native workspace, and pass the CLI Agents collision probe. A specialist selection with `parentRunId` joins that run; a standalone selection claims and attaches a run (`src/rooms/native-agent/native-dispatch.ts:232-296`).
15. For a pending workspace, dispatch prepares the native agent on the selected host and stores its profile and environment in thread KV. For an attached workspace, it binds a standalone run with compare-and-set, reuses a cached launcher for an already-bound chat, or prepares and stores a refreshed launcher (`src/rooms/native-agent/native-dispatch.ts:298-355`).
16. `nativeContributedEnv` skips catalog calls with a null thread id. For a selected thread, it refreshes the launcher from the attached environment when possible, returns a cached launcher if refresh exceeds 2.5 seconds or fails, and returns an empty list when there is no usable cached environment (`src/rooms/native-agent/native-dispatch.ts:369-423`).

## Modes and branches

| Input state | Behavior | Failure result |
|---|---|---|
| New thread | The composer requests activation context for its project, shows blocks for pending context or missing project, then prepares a selection when the action is enabled (`src/rooms/native-agent/ui/composer-enable.tsx:98-124`, `:126-141`). | Pending disables the button; any returned activation block prevents `prepare` (`src/rooms/native-agent/ui/composer-enable.tsx:114-127`). Workspace and profile checks happen during server dispatch. |
| Existing environment reuse | Verify existence and project, host, and path consistency (`src/rooms/native-agent/server/activation.ts:29-38`). | Throws a specific environment mismatch code. |
| Existing host environment | Require a host id and verify it belongs to a configured project source (`src/rooms/native-agent/server/activation.ts:44-49`). | Throws when host is missing or outside the project. |
| Provider-provisioned environment | Verify selected host association and provider availability (`src/rooms/native-agent/server/activation.ts:51-60`). | Throws on unknown provider or project-host mismatch. |
| Stored native profile selection | Compile the requested profile and persist a prepared session record keyed by its token (`src/rooms/native-agent/server/native-profile.ts:12-30`). | Corrupt stored profiles and IDs that match neither an owned nor stock profile throw explicit errors (`src/rooms/native-agent/server/native-profile.ts:14-20`). |
| Mention selection token | Read and parse the stored session record before building mention context (`src/rooms/core/server/native-wiring.ts:13-25`). | Missing tokens log a debug trace and throw an instruction to choose the profile again; malformed records fail schema parsing (`src/rooms/core/server/native-wiring.ts:18-24`). |
| Stream retry ownership | Retry handling receives failure details and an ownership predicate (`src/rooms/core/server/native-wiring.ts:35-57`). | Canceled attempts are excluded; event-list failure produces no failure detail; role/run metadata or the native-thread KV marker identifies owned threads (`src/rooms/core/server/native-wiring.ts:40-57`). |
| Native dispatch token | Hidden composer submission and mention markers are deduplicated; a handoff inherits the source thread's profile only when its first block is BB's continue-from marker with a matching thread mention (`src/rooms/native-agent/native-dispatch.ts:143-167`, `:185-230`). | Multiple tokens, invalid hidden data, missing selection, provider mismatch, project mismatch, workspace failure, and CLI Agents collision return a rejection; an ordinary unselected chat proceeds (`src/rooms/native-agent/native-dispatch.ts:185-256`, `:258-280`). |
| Native launcher refresh | `nativeContributedEnv` refreshes from the actual attached environment and caches the returned env and agent id (`src/rooms/native-agent/native-dispatch.ts:369-406`). | With a cached launcher it waits up to 2.5 seconds then returns the cached env; a failed refresh also uses cache. If refresh and cache both provide no env, it returns an empty list (`src/rooms/native-agent/native-dispatch.ts:407-423`). |
| No ready native snapshot | Detect configured PM workspace and test compatible installed engine (`src/rooms/native-agent/server/activation.ts:72-90`). | Throws if project setup is missing or no compatible engine exists. |

The helper environment branch also depends on the provider and thread role:

| Provider thread | Environment added | Failure behavior |
|---|---|---|
| Codex, Cursor, or OpenCode helper with role metadata other than `pm` | Add `LANE_PILOT_ROLE`; after successful host preparation, `PATH` puts `bb`, `ssh`, `scp`, and `sftp` behind guard wrappers. OpenCode v2 receives the values as session shell environment (`src/rooms/native-agent/server/helper-bb-shim.ts:5-19`, `:78-86`). | An unknown `prepareBbShim` host method logs a warning and returns the role marker without `PATH`; another preparation error rejects resolver execution (`src/rooms/native-agent/server/helper-bb-shim.ts:53-64`, `:82-86`). A Codex writer may also receive a separate `CODEX_HOME` when strict-user mode is on and the host call returns one (`src/rooms/native-agent/server/helper-bb-shim.ts:89-98`). |
| PM, owner thread, or catalog lookup with no thread id | No BB shim variables are contributed (`src/rooms/native-agent/server/helper-bb-shim.ts:71-80`). | Metadata lookup failure logs and returns no entries; null thread id returns immediately (`src/rooms/native-agent/server/helper-bb-shim.ts:71-76`). |

## Business rules

- A writer thread cannot become a PM thread (`src/rooms/native-agent/server/activation.ts:63-68`).
- A reused environment cannot silently change its project, host, or path (`src/rooms/native-agent/server/activation.ts:29-38`).
- A new-thread selection requires BB's experimental dispatch-data hook and shows an upgrade error when it is missing; an existing chat changes agent through `switch_chat_agent` without attaching dispatch data (`src/rooms/native-agent/ui/composer-enable.tsx:130-145`, `:150-151`).

## Public API or commands

The activation UI calls `activation_context`, `prepare_native_session`, and `native_install_start` through its typed RPC client (`src/rooms/native-agent/ui/composer-enable.tsx:58-60`, `:106-112`, `:150-154`). `storeNativeSelection` prepares the token record used by native session selection (`src/rooms/native-agent/server/native-profile.ts:12-30`).

The host-worker public index exports the typed handler implementations, including the native prepare and BB shim handlers (`src/rooms/host-worker/index.ts:1-3`, `src/rooms/host-worker/host-handlers.ts:836-852`).

## Runtime contracts and core

### `hostContract`

1. The contracts room exports `hostContract` separately from the app `rpcContract`; the host module passes its method map to `defineRpcContract` (`src/rooms/contracts/index.ts:11-17`, `src/rooms/contracts/host.ts:8`).
2. Each host operation declares strict input/output objects. Inputs carry `requestedHostId`; declared absolute paths must begin with `/`, names and commands have bounds, and enum fields define accepted actions and result states (`src/rooms/contracts/host.ts:7-13`, `:15-46`).
3. The map declares native install, Git ownership/worktree actions, jobs, stability, disk, integrate, documentation and model/council provider methods; it also spreads the Anamnesis method map (`src/rooms/contracts/host.ts:8-72`, `:83-141`, `:496-512`).
4. `gitIntegrate` accepts required host/base/worktree/message fields, optional committed-only/bookkeeping options, optional `ownsPaths`, and optional bounded replay-check commands; output distinguishes merged/up-to-date/conflict/failed/busy and may carry checks/rebuild results (`src/rooms/contracts/host.ts:83-95`).
5. A contract rejection remains a call failure; a valid operation can return its declared state, reason, conflicts, or job status. The schema does not retry or repair host operations (`src/rooms/contracts/host.ts:8-29`, `:50-65`, `:83-95`).

| Procedure branch | Inputs and results | Failure behavior |
|---|---|---|
| Native install | Action `install`, `enable`, `disable`, `remove`, or `status`; result is absent/prepared/enabled/disabled. | Invalid action/host id fails validation. |
| Git worktree | Snapshot, remove, sync, create, integrate; result enums carry clean/saved/missing, synced/up-to-date/dirty/conflict/failed, ready/failed, or merge statuses. | Operation failures are domain results with reason/conflict fields where declared. |
| Git integrate extensions | Optional ownership patterns, bookkeeping paths, and 1–20 sandbox replay commands with per-command timeouts bounded in schema (`src/rooms/contracts/host.ts:83-95`). | Invalid bounds/paths reject validation; returned checks contain exit code/stdout/stderr. |
| Host job | Start uses a declared kind, input record, 10-second minimum and configured maximum deadline; status and cancel address a job reference. | Runtime state includes running/succeeded/failed/cancelled/lost; transport rejection propagates. |

### `rpcContract`

1. The contracts room imports `rpcShell`, `rpcNative`, `rpcRuns`, `rpcSettings`, `rpcOps`, `rpcKnowledge`, `rpcWorkflow`, and `rpcWorld`, then spreads them into one `defineRpcContract` call (`src/rooms/contracts/index.ts:1-9`, `:18-27`).
2. Composition does not add feature-gate branches or transform handler results; each route map supplies its own input/output schema (`src/rooms/contracts/index.ts:18-27`).
3. The contract is registered once with the combined handler map by `registerRpc`; each handler is timed, and thrown handler or registration errors propagate to the RPC caller (`src/rooms/core/server/rpc.ts:48-65`, `src/rooms/core/server/rpc-timing.ts:12-40`).

| Condition | Result | Failure behavior |
|---|---|---|
| Valid method input | Contract validates the route payload and exposes its declared result shape to BB (`src/rooms/contracts/index.ts:18-27`). | The domain handler can return its own refusal value or reject. |
| Invalid or extra input fields | Strict route schemas reject fields or values outside the method contract (`src/rooms/contracts/rpc-native.ts:4-20`, `src/rooms/contracts/rpc-ops.ts:5-27`). | Handler execution does not occur. |
| Registration or handler rejection | The registration wrapper and timing wrapper do not convert the rejection to a route result (`src/rooms/core/server/rpc.ts:48-65`, `src/rooms/core/server/rpc-timing.ts:12-40`). | The RPC call rejects; timing logs elapsed time and error classification. |

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

`createCore` is the shared dependency object for server rooms; host contract shapes remain separate from app RPC shapes (`src/rooms/core/server/core.ts:31-49`, `src/rooms/contracts/index.ts:11-27`). A native CLI run takes host, workspace, and writer model from run binding/current settings rather than stale prototype configuration (`src/rooms/core/server/core.ts:306-320`, `:370-373`).

## Gotchas

A successful UI preparation attaches a token to the next submission; submission clears the pending UI selection (`src/rooms/native-agent/ui/composer-enable.tsx:112-128`). Environment validation is performed again server-side, so a stale composer selection can still fail during activation (`src/rooms/native-agent/server/activation.ts:24-60`). Core initialization registers disposal callbacks before it returns; host transport errors remain rejections unless a specific handler converts them into a domain state (`src/rooms/core/server/core.ts:31-47`, `:83-108`, `src/rooms/contracts/host.ts:6-13`).
