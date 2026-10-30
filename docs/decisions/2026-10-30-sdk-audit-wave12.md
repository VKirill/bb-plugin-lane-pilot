---
title: "SDK audit wave 12: implemented items and rejections"
type: decisions
status: decided
---

# SDK audit wave 12 (sdk-owner-audit.md, sdk-gemini-audit.md)

Every open row of the two SDK audits was checked against `main` (0.1.391). Dispositions below; already-fixed rows were proven in code rather than re-implemented.

## Already on main before this wave

| Row | Proof |
|---|---|
| A-b5 `threadPanelAction` → `experimental_tab` | `app.tsx` `threadActionTab`: feature-tests `slots.experimental_tab` (context `thread`, availability `action`), falls back to the retired slot on an older BB. `tests/helper-threads-phase.test.tsx` renders the helper tab through it (6/6). |
| A-u1 `experimental_threadRowMetadata` | `app.tsx` `lane-pilot-helper-role`: role badge on sidebar rows of helper threads. |
| A-u2 / B-7 `experimental_threadAction` | `app.tsx` `lane-pilot-helpers`: menu item that opens the helpers tab via `experimental_panel.openTab`. |
| B-1 `useRpcQuery` hooks | `src/rooms/ui-shell/ui/use-lp-rpc-query.ts` + `src/rooms/contracts/ui-query.ts`; manual `setInterval` loops route through it. |

## Implemented in this wave

| Row | Commit | What |
|---|---|---|
| A-b2 | `bb-memory` reads `memory.listMemories` via `bb.sdk.plugins.callRpc` (server side, passed in the collect request); the host's `bb` CLI stays the fallback. `tests/anamnesis/sources.test.ts`. |
| B-4 | `flagMissingJevKey` calls `bb.status.needsConfiguration` when no Jev key resolves; the mark resets per load. `onInstall` rejected: nothing global to seed — settings are per project and migrations already run at load. |
| B-9 | `experimental_invalidate(["world_version"])` on every attempt bump in `outbound.ts`; the read's tag is declared in `ui-query.ts`. The interval remains the old-BB fallback. |
| B-x3 | `app.commands.register lane-pilot-helpers` opens the helpers tab; `PluginCommandContext` offers no navigation call, so a Cockpit jump cannot exist. |
| B-x4 | `experimental_usePageTitle` on the cockpit nav panel prefixes the window title with the owner-waiting count. |
| A-u3 | `experimental_threadContextSegment` `lane-pilot-live-segment`: visible only with live work, expands into `ThreadLive`. |

## Rejected, with the reason

| Row | Reason |
|---|---|
| A-u4 `setThreadRowStatus` | Duplicates A-u1: same `thread_live`/`list_helper_threads` data on the same sidebar row; a second status channel adds no information. |
| A-u5 / B-2 `settings.define` | LP settings are per-project with CAS versions (`rpc-settings` `expectedVersion`); the descriptor model carries none of that. Jev keys in Env Catalog are shared across hosts and plugins — moving them breaks the rotation model. |
| A-u6 `composer sendMenu` | Cosmetic: activation already rides `experimental_vkSetDispatchData` and a real action button exists in `composer-enable.tsx`. |
| A-c1 `pluginMetadata` in tool context | Benefit is one loopback `getPluginMetadata` per PM tool call (5 call sites, not 15+); a VK core patch plus stock fallback does not pay for that. |
| A-c2 `lastTurnId`/`isSubAgent` on `thread.idle` | Would not remove the event read in `completion.ts`: the decision still needs the queue and error events. Core patch for a partial payload. |
| B-3 `threads.wait` | `threads.wait` polls internally at 250 ms and never checks `listRunning`; no win over the current 1 s poll in `writer-stop`. |
| B-5 `experimental_onSignal` jobs | Jobs run as detached processes outside the worker; signals are ephemeral and `emitSignal` exists only in the worker RPC context — polling survives anyway. |
| B-8 drop `deploy_drain` RPC | `bb-plugin-push` invokes it on every deploy as the closing step; removing it requires editing the infra script outside this repository. |
| B-13 `(bb as …).vk` casts | Required to compile against a stock SDK where the vk methods are not in the types. |
| B-x2 `defineCli` | ~40 subcommands parse fine today; a spec-kit rewrite is cosmetic. |
| B-x5 `settingsSection` | Bound to B-2: without descriptor-backed settings the section is empty. |
| B-x6 `uiPreferences` | Locale and agent profiles are LP domain; a second source of truth for a slice of preferences is a net loss. |
