---
title: Jev workspace overview
type: overview
created: 2026-11-05
updated: 2026-11-05
status: active
confidence: high
tags: [jev, judgments, workspace]
sources:
  - packages/jev/package.json
  - packages/jev/src/index.ts
  - packages/jev/src/runtime.ts
  - packages/jev/src/run.ts
  - packages/jev/src/client.ts
  - packages/jev/src/provider.ts
  - packages/jev/src/thresholds.ts
  - packages/jev/src/receipts.ts
  - packages/jev/src/registry.ts
  - packages/jev/src/output-guard.ts
  - src/rooms/core/server/core.ts
  - src/rooms/jev/cli.ts
  - src/rooms/validators/deliverable.ts
---

# Jev workspace overview

TL;DR: `@lane-pilot/jev` supplies a typed judgment runtime, stores call receipts in SQLite, and keeps output-guard blocks and counters in the plugin key-value store.

## Purpose

Each judgment contract supplies typed questions and code-owned `decide` and `fallback` functions (`packages/jev/src/registry.ts:20-42`).

The runtime returns a Jev decision, an escalation request, or the deterministic fallback (`packages/jev/src/run.ts:34-46`).

The package root re-exports its modules (`packages/jev/src/index.ts:1-14`).

## How it is used

1. The plugin server installs a process-wide Jev instance with a provider endpoint and SQLite database; `jev()` returns that instance to callers (`packages/jev/src/runtime.ts:8-20`, `src/rooms/core/server/core.ts:101`).
2. Importing a judgment module calls `defineJudgment`, which registers it in the in-memory map (`packages/jev/src/registry.ts:43-55`). The runtime exposes `judge`, `judgeMany` and `judgeBundle` (`packages/jev/src/run.ts:190-194`).
3. The runtime redacts state, resolves mode and thresholds, groups compatible work into provider requests, and returns a typed verdict (`packages/jev/src/run.ts:93-107`, `packages/jev/src/run.ts:145-180`).
4. When a database is supplied, a non-cached judgment call writes a receipt; labels and reports use those receipts later (`packages/jev/src/run.ts:109-119`, `packages/jev/src/receipts.ts:72-93`).

## Public entry points

The package root exports the client, provider catalog, types, registry, thresholds, process runtime, runner, receipts, output guard, calibration, watch, autoresearch and label helpers (`packages/jev/src/index.ts:1-14`). `package.json` additionally exports `./provider` and individual built-in judgment subpaths; it does not export every `src/judgments/*.ts` file (`packages/jev/package.json:8-28`).

There is no route or bot-command implementation in this workspace; the package code map has no marked entry points. The parent plugin owns the Jev CLI (`src/rooms/jev/cli.ts:1-20`).

## Configuration and providers

Project settings are `jev.enabled`, `jev.modes`, `jev.thresholds` and `jev.calibrated_thresholds`; modes are `off`, `shadow` and `active`, and thresholds are clamped to each judgment's declared range (`packages/jev/src/thresholds.ts:6-16`, `packages/jev/src/thresholds.ts:29-50`).

Provider IDs are `typesafe` and `openlux`; an absent or unknown provider setting resolves to TypeSafe (`packages/jev/src/provider.ts:12-27`).

The core server reads provider credentials and installs the runtime (`src/rooms/core/server/core.ts:66-101`). The client endpoint type pairs provider details with its API key (`packages/jev/src/client.ts:30-40`).

## Consumers

The parent plugin core imports `installJev`, `jev`, and provider symbols (`src/rooms/core/server/core.ts:25-26`). The deliverable validator imports Jev and four judgment modules (`src/rooms/validators/deliverable.ts:1-6`).

The manifest marks `@lane-pilot/jev` as a `private` package and contains no dependency declaration (`packages/jev/package.json:1-30`).

## Related pages

- [Client and runtime](features/client-runtime.md)
- [Typed judgments](features/typed-judgments.md)
- [Output guard](features/output-guard.md)
- [Receipt calibration and monitoring](features/receipt-calibration.md)
- [Data model](data-model.md)
- [Gotchas](gotchas.md)
- [System architecture](../../../docs/architecture.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Jev client and runtime](features/client-runtime.md)
- [Typed judgments](features/typed-judgments.md)
