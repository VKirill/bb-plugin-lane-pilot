---
title: Realtime Signal Contract
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [ui-kit, realtime, events]
sources:
  - packages/ui-kit/src/realtime-channel.ts
  - src/rooms/core/server/realtime.ts
  - src/rooms/workflow/server/workflow.ts
  - src/rooms/ui-shell/ui/use-lp-realtime.ts
  - packages/ui-kit/package.json
---

# Realtime Signal Contract

TL;DR: The `realtime-channel` subpath defines project-scoped channel names, the allowed signal kinds, a validating payload parser, and polling intervals shared by app code.

## Purpose

The contract is the shared vocabulary for UI and server realtime updates; the package metadata exposes it as `@lane-pilot/ui-kit/realtime-channel` ((packages/ui-kit/package.json:16-18), (packages/ui-kit/src/realtime-channel.ts:1-22)). The server imports its channel and kind definitions, while the UI consumes the parser and poll intervals ((src/rooms/core/server/realtime.ts:1-2), (src/rooms/ui-shell/ui/use-lp-realtime.ts:1-3)).

## How it works

1. Import the contract from `@lane-pilot/ui-kit/realtime-channel`, keeping server and client types aligned (packages/ui-kit/package.json:16-18).
2. Choose one allowed `kind`: `helpers`, `council`, `rules`, `workflow`, `workflow-draft`, or `schedule` (packages/ui-kit/src/realtime-channel.ts:1-6).
3. Build the project channel with `lpChannel(projectId)`, which prefixes the identifier with `lp:`; use `LP_ALL_PROJECTS` (`-`) for the global workflows library channel (packages/ui-kit/src/realtime-channel.ts:6-10).
4. Parse incoming unknown payloads with `parseLpSignal`; it rejects non-objects or unsupported kinds, and includes optional identifiers only when their values are strings (packages/ui-kit/src/realtime-channel.ts:12-17).
5. While the live connection is up, use `LIVE_FALLBACK_MS` (30,000 ms); while connecting or reconnecting, use `OFFLINE_POLL_MS` (4,000 ms) (packages/ui-kit/src/realtime-channel.ts:19-22).

### Modes

| State | Interval | Intended use | Evidence |
|---|---:|---|---|
| Live connection up | 30,000 ms | Fallback poll to catch missed signals | (packages/ui-kit/src/realtime-channel.ts:19-21) |
| Connecting or reconnecting | 4,000 ms | Poll while no live connection | (packages/ui-kit/src/realtime-channel.ts:21-22) |
| Project channel | `lp:<projectId>` | Project-specific updates | (packages/ui-kit/src/realtime-channel.ts:9-10) |
| Global workflows channel | `-` constant | Global workflows library signal scope | (packages/ui-kit/src/realtime-channel.ts:6-10) |

### Failures

`parseLpSignal` returns `null` for nullish values, primitives, arrays’ unsupported payload shape unless it includes a valid `kind` property, and objects with an unknown or non-string kind. It drops optional IDs whose values are not strings (packages/ui-kit/src/realtime-channel.ts:12-17). It does not validate whether accepted IDs are non-empty or correspond to existing records (packages/ui-kit/src/realtime-channel.ts:12-17).

## Business rules

- The six string values in `LP_REALTIME_KINDS` are the accepted signal kinds (packages/ui-kit/src/realtime-channel.ts:1-3).
- `threadId`, `runId`, and `draftId` are optional strings; the code comment assigns `runId` to `workflow` signals and `draftId` to `workflow-draft` signals, but the parser does not enforce a relationship between kind and ID ((packages/ui-kit/src/realtime-channel.ts:4-5; packages/ui-kit/src/realtime-channel.ts:12-17)).
- Project identity is part of the channel name because BB broadcasts plugin signals to connected clients (packages/ui-kit/src/realtime-channel.ts:9-10).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `LP_REALTIME_KINDS`, `LpRealtimeKind` | Allowed signal kinds and union type | (packages/ui-kit/src/realtime-channel.ts:1-3) |
| `LpRealtimeSignal` | Signal payload type | (packages/ui-kit/src/realtime-channel.ts:4-5) |
| `LP_ALL_PROJECTS`, `lpChannel` | Global channel identifier and project channel formatter | (packages/ui-kit/src/realtime-channel.ts:6-10) |
| `parseLpSignal` | Runtime validation and normalization | (packages/ui-kit/src/realtime-channel.ts:12-17) |
| `LIVE_FALLBACK_MS`, `OFFLINE_POLL_MS` | Polling intervals in milliseconds | (packages/ui-kit/src/realtime-channel.ts:19-22) |

## Dependencies

This contract file has no imports, allowing UI and server source files to import it without pulling component dependencies (packages/ui-kit/src/realtime-channel.ts:1-22). The package defines it as a separate export path (packages/ui-kit/package.json:16-18).

<!-- lane-pilot:backlinks -->
## Referenced by

- [UI Primitives](primitives.md)
- [UI Kit — Overview](../overview.md)
