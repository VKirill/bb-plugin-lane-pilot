---
title: Native agent activation and dispatch
type: component
created: 2026-10-10
updated: 2026-10-10
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
6. Core native wiring resolves the stored selection token into mention context and routes `message.dispatch` to the native dispatch handler (`src/rooms/core/server/native-wiring.ts:13-30`).

## Modes and branches

| Input state | Behavior | Failure result |
|---|---|---|
| New thread with project and usable binding | Show the enable action and prepare selected agent dispatch data (`src/rooms/native-agent/ui/composer-enable.tsx:45-60`, `:84-94`). | Pending, missing project, missing binding, or unavailable compiled agent disables activation (`src/rooms/native-agent/ui/composer-enable.tsx:37-42`, `:84-94`). |
| Existing environment reuse | Verify existence and project, host, and path consistency (`src/rooms/native-agent/server/activation.ts:29-38`). | Throws a specific environment mismatch code. |
| Existing host environment | Require a host id and verify it belongs to a configured project source (`src/rooms/native-agent/server/activation.ts:44-49`). | Throws when host is missing or outside the project. |
| Provider-provisioned environment | Verify selected host association and provider availability (`src/rooms/native-agent/server/activation.ts:51-60`). | Throws on unknown provider or project-host mismatch. |
| No ready native snapshot | Detect configured PM workspace and test compatible installed engine (`src/rooms/native-agent/server/activation.ts:72-90`). | Throws if project setup is missing or no compatible engine exists. |

## Business rules

- A writer thread cannot become a PM thread (`src/rooms/native-agent/server/activation.ts:63-68`).
- A reused environment cannot silently change its project, host, or path (`src/rooms/native-agent/server/activation.ts:29-38`).
- The composer selection is attached through BB's experimental dispatch-data hook; without it the UI displays an upgrade error (`src/rooms/native-agent/ui/composer-enable.tsx:101-115`).

## Public API or commands

The activation UI calls the typed `activation_context`, `prepare_native_session`, and `native_install_start` RPC methods (`src/rooms/native-agent/ui/composer-enable.tsx:71-80`, `:112-115`). The server host interface is described by `hostContract` (`src/rooms/contracts/host.ts:6-15`).

## Gotchas

A successful UI preparation attaches a token to the next submission; submission clears the pending UI selection (`src/rooms/native-agent/ui/composer-enable.tsx:112-128`). Environment validation is performed again server-side, so a stale composer selection can still fail during activation (`src/rooms/native-agent/server/activation.ts:24-60`).
