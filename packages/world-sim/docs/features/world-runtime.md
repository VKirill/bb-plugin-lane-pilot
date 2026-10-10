---
title: World runtime
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [world-sim, runtime, state]
sources:
  - packages/world-sim/src/world.ts
  - packages/world-sim/src/types.ts
  - packages/world-sim/src/rng.ts
  - packages/world-sim/src/sim.ts
  - packages/world-sim/src/index.ts
  - packages/world-sim/package.json
---

# World runtime

TL;DR: The runtime creates a plain-data city state, advances it in fixed simulation steps, and derives saved JSON, event deltas and client snapshots from that state (`packages/world-sim/src/world.ts:24-37`, `packages/world-sim/src/world.ts:111-183`).

## Purpose

This module owns world lifecycle and the order in which simulation subsystems run. The public API is re-exported by the package root (`packages/world-sim/src/index.ts:10-11`).

## How it works

1. `createWorld(seed, options)` sets defaults for game-hour length, active scenarios and start hour, generates the map and populates buildings and citizens (`packages/world-sim/src/world.ts:24-37`).
2. Each internal `tick` advances time and tick count, updates citizen needs, evaluates scenario events when due, updates construction, updates services, then asks unassigned citizens to choose a plan (`packages/world-sim/src/world.ts:88-109`).
3. `step(state, dtSeconds)` adds elapsed seconds to `carry` and runs one-second ticks while a complete fixed step remains; it mutates and returns the same state with emitted events (`packages/world-sim/src/world.ts:111-118`).
4. `catchUp(state, elapsedSeconds, maxStep)` uses coarse ticks, caps elapsed time at seven days, clears generated events and returns an empty event list (`packages/world-sim/src/world.ts:20-21`, `packages/world-sim/src/world.ts:120-135`).
5. `serializeWorld` omits `map`; `parseWorld` checks the schema number and regenerates that static map. `cloneState` copies through JSON encode/decode (`packages/world-sim/src/world.ts:137-147`).
6. `snapshot` projects state into the client shape and includes the map only when `withMap` is true (`packages/world-sim/src/world.ts:151-183`).

### Runtime branches

| Call or condition | Input or limit | Output/state effect | Failure behavior |
|---|---|---|---|
| `step` | elapsed simulation seconds; fixed step from state config | Mutates the same state and returns events (`packages/world-sim/src/world.ts:111-118`). | Negative or non-finite elapsed values have no explicit validation; they affect `carry` directly (`packages/world-sim/src/world.ts:112-117`). |
| `catchUp` | elapsed seconds and `maxStep` (default 30) | Coarse advances, no returned events; elapsed is clamped to `[0, 7 days]` (`packages/world-sim/src/world.ts:124-135`). | Exceptions from subsystem code propagate; events generated during catch-up are discarded (`packages/world-sim/src/world.ts:125-134`). |
| `parseWorld` | JSON string with `schema === WORLD_SCHEMA_VERSION` | Restores the static map (`packages/world-sim/src/world.ts:142-146`). | Invalid JSON throws from `JSON.parse`; another schema throws an explicit error (`packages/world-sim/src/world.ts:142-145`). |
| `snapshot` | state and optional `withMap` | Client projection with map omitted by default (`packages/world-sim/src/world.ts:172-183`). | No validation or cloning of all nested snapshot values is performed (`packages/world-sim/src/world.ts:173-183`). |

## Business rules

- New worlds begin with 24 citizens unless `citizens` is supplied, and the game clock starts at hour 6 with 120 simulation seconds per game hour unless options override those values (`packages/world-sim/src/world.ts:24-35`).
- Simulation steps use a fixed one-second interval (`packages/world-sim/src/world.ts:19`, `packages/world-sim/src/world.ts:25`, `packages/world-sim/src/world.ts:114-117`).
- The random generator state is stored in `WorldState.rng`, so random draws are part of serialization and affect later outcomes (`packages/world-sim/src/types.ts:240-245`, `packages/world-sim/src/rng.ts:3-10`).
- `parseWorld` accepts only the current schema version; the version constant is `1` (`packages/world-sim/src/types.ts:7-8`, `packages/world-sim/src/world.ts:142-146`).

## Public API

| Import / export | File:line | Purpose |
|---|---|---|
| `createWorld`, `step`, `catchUp`, `cloneState`, `serializeWorld`, `parseWorld`, `snapshot` | `packages/world-sim/src/world.ts:24-37`, `packages/world-sim/src/world.ts:111-183` | Create, advance, clone, save, restore and project state. |
| `WorldOptions`, `WorldSnapshot` | `packages/world-sim/src/world.ts:13-14`, `packages/world-sim/src/world.ts:151-170` | Constructor options and client projection types. |
| `WorldState`, `StepResult`, `WorldConfig`, `WORLD_SCHEMA_VERSION` | `packages/world-sim/src/types.ts:7-8`, `packages/world-sim/src/types.ts:230-279`, `packages/world-sim/src/types.ts:311` | State and lifecycle types. |
| `dayOf`, `hourOf` | `packages/world-sim/src/sim.ts:15-16` | Convert simulation time to game clock values. |

## Gotchas

Catch-up deliberately returns no events; a caller that needs a consistent client view fetches a new snapshot after catch-up (`packages/world-sim/src/world.ts:121-135`). See [Gotchas](../gotchas.md).

## Dependencies

The runtime composes local modules for needs, buildings, construction, map generation, random values, scenarios, services, simulation planning and types (`packages/world-sim/src/world.ts:1-11`). The package has no declared runtime dependencies (`packages/world-sim/package.json:11-14`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [World simulation overview](../overview.md)
