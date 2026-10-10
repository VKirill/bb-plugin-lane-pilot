---
title: Jev adapter for native writer reasoning
type: component
created: 2026-09-23
updated: 2026-10-10
status: active
confidence: high
tags: [jev, reasoning, native-writer]
sources:
  - src/rooms/core/server/core.ts
  - src/rooms/writer/server/dispatch.ts
  - packages/jev/src/run.ts
  - packages/jev/src/provider.ts
  - packages/jev/src/client.ts
  - packages/models/src/jev-reasoning.ts
  - packages/models/src/picker-compat.ts
  - src/rooms/contracts/rpc-runs.ts
---

# Jev adapter for native writer reasoning

TL;DR: Jev classifies the dispatched task plan and Lane Pilot uses its effort only when the selected BB model advertises that reasoning level.

## Purpose

Choose a reasoning effort for native writer dispatch using the task plan and the selected provider/model catalog (`src/rooms/writer/server/dispatch.ts:107-120`, `packages/models/src/jev-reasoning.ts:4-26`). The ordinary terminal Lane Stack routing path is separate from this BB adapter.

## How it works

1. Core resolves the configured Jev provider and reads its key from Env Catalog; if that key is missing and the provider is not TypeSafe, it tries TypeSafe's key (`src/rooms/core/server/core.ts:50-85`).
2. Core installs the Jev client and SQLite receipt writer for the plugin instance (`src/rooms/core/server/core.ts:87-88`).
3. `createJev` builds the judgment runner; it redacts the judgment state, collects questions and resolves mode and thresholds (`packages/jev/src/run.ts:56-64`).
4. Requests with the same state and model are grouped; question and state limits split larger groups into multiple calls (`packages/jev/src/run.ts:99-117`).
5. Failed calls, invalid answers, and decision exceptions return the judgment's deterministic fallback; shadow mode records the model's decision but returns fallback (`packages/jev/src/run.ts:82-96`).
6. The writer dispatch path resolves the model's advertised reasoning levels and maps the Jev choice to a compatible level; if selection is unavailable or incompatible, it retains the configured manual fallback and records the trace (`packages/models/src/jev-reasoning.ts:4-26`, `packages/models/src/picker-compat.ts:1-12`).

## Modes and states

| Mode or result | Effect | Evidence |
|---|---|---|
| `off` | Does not call Jev and returns the judgment fallback with `status: off` (`packages/jev/src/run.ts:99-105`). |
| `shadow` | Calls Jev and records its candidate, but returns the deterministic fallback (`packages/jev/src/run.ts:93-96`). |
| Active decision | Returns `by: jev` when the decision rule resolves without escalation (`packages/jev/src/run.ts:93-97`). |
| Escalation | Returns the escalation target when the judgment's decision rule requests a stronger judge (`packages/jev/src/run.ts:93-96`). |
| Call or answer failure | Returns fallback with a failure status; receipt insertion failure is logged and does not replace the verdict (`packages/jev/src/run.ts:66-79`, `:82-91`). |
| Unsupported model effort | Keeps configured writer effort and records a compatibility/fallback reason (`packages/models/src/jev-reasoning.ts:4-26`, `packages/models/src/picker-compat.ts:1-12`). |

## Business rules

Jev's deterministic fallback remains the effective result when it is off, shadowed, missing usable answers, or cannot decide (`packages/jev/src/run.ts:82-97`). The model catalog controls whether an automatic reasoning choice is eligible; Lane Pilot does not send unsupported reasoning levels (`packages/models/src/jev-reasoning.ts:4-26`).

## Public API or commands

The package exposes `judge`, `judgeMany`, `judgeBundle`, `outcome`, and `enabled` (`packages/jev/src/run.ts:35-42`). Native writer selection is visible in the `lastWriterTrace` fields of the runs RPC response (`src/rooms/contracts/rpc-runs.ts:116-133`).

## Gotchas

The key lookup is cached for ten minutes in the plugin core (`src/rooms/core/server/core.ts:53-69`). Receipt persistence is optional when no database is provided or the judgment mode is off (`packages/jev/src/run.ts:66-68`). This page replaces a draft whose source list named temporary chat files and pinned SDK extracts; those files are not implementation sources for this plugin.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot overview](overview.md)
- [Shared packages](packages.md)
