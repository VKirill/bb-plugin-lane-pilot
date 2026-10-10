---
title: World simulation overview
type: overview
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [world-sim, simulation, package]
sources:
  - packages/world-sim/src/scenarios.ts
  - packages/world-sim/src/index.ts
  - packages/world-sim/src/world.ts
  - packages/world-sim/package.json
  - packages/world-sim/src/types.ts
  - packages/world-sim/src/protocol.ts
  - packages/world-sim/src/binding.ts
  - src/rooms/world/server/service.ts
  - src/rooms/world/server/store.ts
---

# World simulation overview

TL;DR: `@lane-pilot/world-sim` is a pure TypeScript library that advances a deterministic city model, translates Lane Pilot work signals into city events, and produces snapshots for clients (`packages/world-sim/package.json:2-14`, `packages/world-sim/src/index.ts:1-12`).

## What it is

This workspace owns the city rules and serializable `WorldState`; it contains no I/O and declares no runtime dependencies (`packages/world-sim/package.json:4-14`). The public package entry is `src/index.ts`, with a separate `./protocol` export that exposes client/server message types and plan interpolation without importing simulation operations (`packages/world-sim/package.json:11-14`, `packages/world-sim/src/protocol.ts:1-6`).

The state contains the generated map, citizens, vehicles, buildings, construction sites, jobs, meetings, scenario runtime and event sequence (`packages/world-sim/src/types.ts:240-279`). The Lane Pilot world room calls this package and owns persistence and hub integration (`src/rooms/world/server/service.ts:1-20`, `src/rooms/world/server/store.ts:1-24`). See the root [architecture](../../../docs/architecture.md) for the system workspace boundary and integration context.

## Stack

- TypeScript ES modules; package metadata points `main`, `types` and `.` to `src/index.ts` (`packages/world-sim/package.json:5-13`).
- JSON scenario documents imported by `src/scenarios.ts` (`packages/world-sim/src/scenarios.ts:8-12`).

## Quick start

The main calls create a state, advance it, apply work signals and create client snapshots; each mutation operates on the passed state (`packages/world-sim/src/world.ts:24-37`, `packages/world-sim/src/world.ts:111-147`, `packages/world-sim/src/binding.ts:78-85`).

```ts
import { createWorld, step, snapshot } from "@lane-pilot/world-sim";
const world = createWorld(seed, { citizens: 24 });
const result = step(world, 1);
const view = snapshot(result.state, { withMap: true });
```

## Public entry points

| Import | Exports | Use |
|---|---|---|
| `@lane-pilot/world-sim` | world lifecycle and snapshots; Lane Pilot signals; map generation; scenario registry; time and position helpers; construction progress helpers; constants and types | Hub integration and simulation code (`packages/world-sim/src/index.ts:2-12`). See [world runtime](features/world-runtime.md), [signals and services](features/signals-and-services.md), and other [features](features/). |
| `@lane-pilot/world-sim/protocol` | `WORLD_CHANNEL`, `WORLD_STREAM_PATH`, `parseWorldBatch`, plan position helper and public types | Protocol-only consumers (`packages/world-sim/src/protocol.ts:1-33`, `packages/world-sim/package.json:11-14`). |

The hub world room is the in-repository consumer identified by imports under `src/rooms/world/server/`; the room service invokes world lifecycle functions and its store calls the serializer and parser (`src/rooms/world/server/service.ts:1-20`, `src/rooms/world/server/store.ts:1-24`).

## Configuration

`createWorld(seed, options)` accepts `citizens`, `scenarios`, `startHour` and `hourSeconds`; unspecified values resolve in the constructor (`packages/world-sim/src/world.ts:13-14`, `packages/world-sim/src/world.ts:24-30`). `fixedStep` is initialized to one simulation second internally. `WorldConfig` stores the selected scenario IDs, starting game hour and seconds per game hour (`packages/world-sim/src/types.ts:230-238`).

## Where to look next

- [World runtime](features/world-runtime.md) — creation, stepping, catch-up, persistence format and snapshots.
- [Citizen behavior](features/citizen-behavior.md) — needs, utility selection, destinations and movement plans.
- [Construction](features/construction.md) — districts, sites, crews, deliveries and completed buildings.
- [Scenarios](features/scenarios.md) — JSON validation, routines, events and effects.
- [Signals and services](features/signals-and-services.md) — work binding and service actors.
- [Map and routing](features/map-and-routing.md) — generated geometry, graphs and path plans.
- [Data model](data-model.md) and [Gotchas](gotchas.md).
