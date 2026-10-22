---
title: Jev adapter for native writer reasoning
type: component
created: 2026-09-23
updated: 2026-10-13
status: active
confidence: medium
tags: [jev, reasoning, native-writer]
sources:
  - src/rooms/core/server/core.ts
  - src/rooms/writer/server/spawn.ts
  - src/rooms/writer/server/dispatch.ts
  - packages/jev/src/run.ts
  - packages/jev/src/provider.ts
  - packages/jev/src/client.ts
  - packages/models/src/jev-reasoning.ts
  - packages/models/src/picker-compat.ts
  - src/rooms/contracts/rpc-runs.ts
  - src/rooms/contracts/rpc-knowledge.ts
  - src/rooms/secrets/server/rpc/jev.ts
  - src/rooms/settings/ui/jev-provider.tsx
  - src/rooms/ui-shell/ui/tab-work.tsx
---

# Jev adapter for native writer reasoning

TL;DR: Jev classifies the dispatched task plan and Lane Pilot uses its effort only when the selected BB model advertises that reasoning level.

## Purpose

Choose a reasoning effort for native writer spawning using the task plan and selected provider/model catalog (`src/rooms/writer/server/spawn.ts:220-264`, `packages/models/src/jev-reasoning.ts:4-26`). The ordinary terminal Lane Stack routing path is separate from this BB adapter.

## How it works

1. Core resolves the configured Jev provider and reads its key from Env Catalog; if that key is missing and the provider is not TypeSafe, it tries TypeSafe's key (`src/rooms/core/server/core.ts:50-85`).
2. Core installs the Jev client and SQLite receipt writer for the plugin instance (`src/rooms/core/server/core.ts:87-88`).
3. `createJev` builds the judgment runner; it redacts the judgment state, collects questions and resolves mode and thresholds (`packages/jev/src/run.ts:56-64`).
4. Requests with the same state and model are grouped; question and state limits split larger groups into multiple calls (`packages/jev/src/run.ts:99-117`).
5. Failed calls, invalid answers, and decision exceptions return the judgment's deterministic fallback; shadow mode records the model's decision but returns fallback (`packages/jev/src/run.ts:82-96`).
6. The writer spawn path asks the host to classify the plan when automatic effort routing is enabled, checks the returned plan proof, resolves the Jev choice against the selected model's advertised reasoning levels, and records the requested and effective levels in the run trace (`src/rooms/writer/server/spawn.ts:220-264`, `packages/models/src/jev-reasoning.ts:4-26`). If the catalog is unavailable or the requested level is unsupported, `resolveJevReasoning` selects the configured manual effort (`packages/models/src/jev-reasoning.ts:10-24`).

## Modes and states

| Mode or result | Effect | Evidence |
|---|---|---|
| `off` | Does not call Jev and returns the judgment fallback with `status: off` (`packages/jev/src/run.ts:99-105`). |
| `shadow` | Calls Jev and records its candidate, but returns the deterministic fallback (`packages/jev/src/run.ts:93-96`). |
| Active decision | Returns `by: jev` when the decision rule resolves without escalation (`packages/jev/src/run.ts:93-97`). |
| Escalation | Returns the escalation target when the judgment's decision rule requests a stronger judge (`packages/jev/src/run.ts:93-96`). |
| Call or answer failure | Returns fallback with a failure status; receipt insertion failure is logged and does not replace the verdict (`packages/jev/src/run.ts:66-79`, `:82-91`). |
| Unsupported Jev effort | Uses the configured manual effort and records a fallback reason (`packages/models/src/jev-reasoning.ts:10-24`). |

## Business rules

Jev's deterministic classification fallback remains the effective result when classification is off, shadowed, missing usable answers, or cannot decide (`packages/jev/src/run.ts:82-97`). A Jev-selected effort is accepted only if the selected model advertises it; otherwise the configured manual effort is used and an unsupported manual effort is recorded in the trace (`packages/models/src/jev-reasoning.ts:10-24`, `src/rooms/writer/server/spawn.ts:241-264`).

## Public API or commands

The package exposes `judge`, `judgeMany`, `judgeBundle`, `outcome`, and `enabled` (`packages/jev/src/run.ts:35-42`). Native writer selection is visible in the nullable `lastWriterTrace` field of the `get_screen` output, including requested and effective reasoning levels and the Jev status (`src/rooms/contracts/rpc-runs.ts:125-127`, `:174-190`).

The global Work settings page renders the Jev provider panel; project and section settings show a note that the provider is global (`src/rooms/ui-shell/ui/tab-work.tsx:34-37`, `:89-97`, `src/rooms/settings/ui/jev-provider.tsx:22-26`, `:130-131`). The panel lets the owner select OpenLux or TypeSafe, see key presence without reading the key, save a key to Env Catalog, and send a test request (`src/rooms/settings/ui/jev-provider.tsx:40-70`). Its RPC methods return provider status, save a single-line key, and test the selected provider with a 15-second timeout; status and test results never include a key (`src/rooms/secrets/server/rpc/jev.ts:8-14`, `:19-50`, `src/rooms/contracts/rpc-knowledge.ts:189-200`).

## Gotchas

The key lookup is cached for ten minutes in the plugin core (`src/rooms/core/server/core.ts:53-69`). Receipt persistence is optional when no database is provided or the judgment mode is off (`packages/jev/src/run.ts:66-68`). This page replaces a draft whose source list named temporary chat files and pinned SDK extracts; those files are not implementation sources for this plugin.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot overview](overview.md)
- [Shared packages](packages.md)
