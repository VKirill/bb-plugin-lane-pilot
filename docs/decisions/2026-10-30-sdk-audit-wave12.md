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
| A-u4 | `experimental_setThreadRowStatus` marks the sidebar row running/error from `thread_live` (`src/rooms/runs/ui/thread-row-status.ts` + content-script `lane-pilot-row-status` in `app.tsx`); stock BB keeps its own row. `tests/thread-row-status.test.ts`. |
| A-c1 | `callerPluginMetadata` (`src/rooms/core/server/context.ts`) takes `context.experimental_vkPluginMetadata` on vk cores, `getPluginMetadata` otherwise — the five PM tool call sites in `tools.ts` plus the conversation/queue `runOf` and the env resolvers of `helper-bb-shim.ts`. |
| A-c2 | `experimental_vkLastTurn` in the vk core supplies `lastTurnId`/`isSubAgent` on `thread.idle`; `thread-observe/src/signals.ts` already consumes it. |
| B-13 | `src/bb-vk.d.ts` augments `BbPluginApi` with the vk namespace once; the `(bb as …).vk` casts are gone (`hook-timeouts.ts`, `core.ts`, `workflow.ts`). |

## Rejected, with the reason

| Row | Reason |
|---|---|
| A-u5 / B-2 `settings.define` | LP settings are per-project with CAS versions (`rpc-settings` `expectedVersion`); the descriptor model carries none of that. Jev keys in Env Catalog are shared across hosts and plugins — moving them breaks the rotation model. |
| A-u6 `composer sendMenu` | Cosmetic: activation already rides `experimental_vkSetDispatchData` and a real action button exists in `composer-enable.tsx`. |
| B-3 `threads.wait` | `threads.wait` polls internally at 250 ms and never checks `listRunning`; no win over the current 1 s poll in `writer-stop`. |
| B-5 `experimental_onSignal` jobs | Jobs run as detached processes outside the worker; signals are ephemeral and `emitSignal` exists only in the worker RPC context — polling survives anyway. |
| B-8 drop `deploy_drain` RPC | `bb-plugin-push` invokes it on every deploy as the closing step (`bb-plugin-push:578,588,696,706,740`). The real hold is the drain-before-rsync step that can still refuse the deploy ("not deploying"); a post-copy lifecycle drain cannot cancel what already shipped. |
| B-x2 `defineCli` | `tools/server/cli.ts` is ~40 subcommands plus nested parsers (~688 lines) that work today; the cost is rewriting every one for help text and types alone. |
| B-x5 `settingsSection` | Bound to B-2: without descriptor-backed settings the section is empty. |
| B-x6 `uiPreferences` | Locale and agent profiles are LP domain; a second source of truth for a slice of preferences is a net loss. |
