---
title: Map and routing
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [world-sim, map, routing]
sources:
  - packages/world-sim/src/world.ts
  - packages/world-sim/src/map.ts
  - packages/world-sim/src/graph.ts
  - packages/world-sim/src/sim.ts
  - packages/world-sim/src/plan-math.ts
  - packages/world-sim/src/types.ts
  - packages/world-sim/src/ai.ts
  - packages/world-sim/src/construction.ts
  - packages/world-sim/src/services.ts
  - packages/world-sim/src/index.ts
  - packages/world-sim/tests/world.test.ts
---

# Map and routing

TL;DR: The map generator creates fixed city geometry and separate sidewalk and road graphs; actors receive time-based plans whose positions clients interpolate (`packages/world-sim/src/map.ts:4-8`, `packages/world-sim/src/types.ts:74-85`, `packages/world-sim/src/plan-math.ts:5-26`).

## Purpose

This capability supplies the static map and graph paths used by citizen walking, vehicle routing and client rendering (`packages/world-sim/src/map.ts:42-149`, `packages/world-sim/src/sim.ts:45-63`).

## How it works

1. `generateMap` lays out a 3×3 grid of blocks around office, park, residential, commercial, industrial and free zones (`packages/world-sim/src/map.ts:9-25`, `packages/world-sim/src/map.ts:42-52`).
2. Each plot receives sidewalk door/entry/slot nodes; the generator links block rings and crossings, then builds a separate road graph with stops by plot doors (`packages/world-sim/src/map.ts:69-89`, `packages/world-sim/src/map.ts:114-149`).
3. `planTo` asks `shortestPath` for graph nodes, makes a continuous path from any current movement to the route, calculates arrival and dwell times, and stores the plan on the actor (`packages/world-sim/src/sim.ts:45-63`).
4. `positionAt(plan,t)` computes a wait/move/dwell phase and interpolated coordinates and heading (`packages/world-sim/src/plan-math.ts:5-26`).
5. Tile rendering encodes grass, road, sidewalk, plots, office and park as digit characters (`packages/world-sim/src/map.ts:151-169`).

### World creation

`createWorld(seed, options)` produces a populated `WorldState` (`packages/world-sim/src/world.ts:24-39`). Its steps are:

1. Construct `WorldConfig`: `hourSeconds` defaults to 120, `fixedStep` is one second, scenario IDs default to `DEFAULT_SCENARIOS`, and `startHour` defaults to 6. Nullish coalescing means supplied zero values are retained (`packages/world-sim/src/world.ts:19`, `packages/world-sim/src/world.ts:24-25`).
2. Generate the fixed map, then initialize schema, seed and RNG state, zeroed clocks/counters/sequences, empty entity and index maps, empty call records, default scenario runtime and revision zero (`packages/world-sim/src/world.ts:26-30`).
3. Create an internal simulation context and populate starter buildings (`packages/world-sim/src/world.ts:32-34`, `packages/world-sim/src/world.ts:40-53`). Commercial plots receive shuffled cafe/shop kinds and names; residential, office, park and industrial plots receive houses, office, park, and depot/warehouse buildings respectively (`packages/world-sim/src/world.ts:42-52`).
4. Populate `options.citizens ?? 24` citizens. Assignment branches calculate builder and inspector counts from the requested population, allocate office staff to available desks, assign clerks to shops/cafes, then fill remaining slots with residents (`packages/world-sim/src/world.ts:55-73`).
5. Initialize each citizen at a shuffled home bed with randomized needs and speed, generated identity, and a quiet wait plan staggered over 0–120 simulation seconds (`packages/world-sim/src/world.ts:74-85`).
6. Clear the setup events and reset `eventSeq` to zero, then return the state (`packages/world-sim/src/world.ts:35-37`).

| Input/branch | Behavior | Outcome or failure |
|---|---|---|
| `hourSeconds`, `scenarios`, `startHour` omitted or nullish | Use defaults 120, `DEFAULT_SCENARIOS`, and 6; `fixedStep` remains 1 (`packages/world-sim/src/world.ts:19`, `packages/world-sim/src/world.ts:24-25`). | Stored in the returned config. No validation of numeric bounds is performed (`packages/world-sim/src/world.ts:24-25`). |
| `citizens` omitted or nullish | Create 24 citizens (`packages/world-sim/src/world.ts:34`). | Population assignment and seeded random initialization run. |
| `citizens` below 8 / at least 8 | Builders are zero below 8; otherwise builder count is `round(count×0.2)`, bounded to 3–24 (`packages/world-sim/src/world.ts:63`). | Builder roles receive depot as workplace (`packages/world-sim/src/world.ts:68-73`). |
| `citizens` at least 12 | Add `max(1, round(count/30))` inspectors; below 12 add none (`packages/world-sim/src/world.ts:64`). | Inspector roles use depot as workplace (`packages/world-sim/src/world.ts:70`). |
| Invalid population length | `populateCitizens` assigns `plan.length = count` without validating integer/nonnegative input (`packages/world-sim/src/world.ts:55-56`, `packages/world-sim/src/world.ts:72-74`). | Negative or fractional counts throw `RangeError`; no partial state is returned to the caller. |

The function has no recovery path for failures during map or population construction; such exceptions propagate and prevent a state from being returned (`packages/world-sim/src/world.ts:24-37`). It assumes the generated map supplies home, office and depot buildings/plots consumed by population setup (`packages/world-sim/src/world.ts:57-76`).

### Graph and plan branches

| Branch | Inputs and output | Failure behavior |
|---|---|---|
| Walk graph | People route over sidewalk nodes; the map graph stores walk, crossing, enter and interior edge kinds (`packages/world-sim/src/types.ts:49-52`, `packages/world-sim/src/map.ts:114-130`). | `shortestPath` returns null when disconnected (`packages/world-sim/src/graph.ts:41-49`, `packages/world-sim/src/graph.ts:92-99`). |
| Road graph | Vehicles route over road nodes; plots keep road stop nodes for deliveries and services (`packages/world-sim/src/map.ts:132-149`). | Same null path result (`packages/world-sim/src/graph.ts:41-49`, `packages/world-sim/src/graph.ts:92-99`). |
| Plan interpolation | `startAt`, `speed`, path length, arrival and `until` govern phase and position (`packages/world-sim/src/types.ts:24-45`, `packages/world-sim/src/plan-math.ts:6-26`). | Empty paths are not validated; interpolation assumes at least one path point (`packages/world-sim/src/plan-math.ts:6-12`). |
| Unreachable target | `planTo` receives null from pathfinding | It substitutes the destination node as a one-point tail, so a disconnected target still yields a plan (`packages/world-sim/src/sim.ts:49-53`). |

## Business rules

- Coordinates use world units on the ground plane, with `x` east and `z` south; one unit represents one tile (`packages/world-sim/src/types.ts:1-5`).
- Map geometry is independent of the world seed; population and buildings use the world RNG after map generation (`packages/world-sim/src/map.ts:4-8`, `packages/world-sim/src/world.ts:24-35`).
- Pedestrians use the sidewalk graph and vehicles use the road graph in the simulation call sites (`packages/world-sim/src/world.ts:1-11`, `packages/world-sim/src/construction.ts:179-185`, `packages/world-sim/src/services.ts:50`, `packages/world-sim/src/ai.ts:129-130`).
- A plan's `actor.pos` is assigned to the endpoint at plan creation; clients use `positionAt` for in-between positions (`packages/world-sim/src/sim.ts:54-63`, `packages/world-sim/src/plan-math.ts:5-26`).

## Public API

| Package export | File:line | Purpose |
|---|---|---|
| `generateMap` | `packages/world-sim/src/map.ts:42-149`, `packages/world-sim/src/index.ts:4` | Generate the static map. |
| `positionAt`, `PlanePose` | `packages/world-sim/src/sim.ts:76-77`, `packages/world-sim/src/index.ts:9` | Interpolate a plan and return pose/phase. |
| `WorldMap`, `Graph`, `GNode`, `GEdge`, `Plan`, `Vec` | `packages/world-sim/src/types.ts:9-10`, `packages/world-sim/src/types.ts:24-52`, `packages/world-sim/src/types.ts:74-85` | Map, graph, coordinates and plans. |

Graph construction and pathfinding functions are implementation modules, not package-root exports (`packages/world-sim/src/graph.ts:3-119`, `packages/world-sim/src/index.ts:1-12`).

## Package shape

`map.ts` builds geometry; `graph.ts` stores and searches weighted adjacency; `sim.ts` creates plans; `plan-math.ts` calculates the visual pose (`packages/world-sim/src/map.ts:42-149`, `packages/world-sim/src/graph.ts:24-100`, `packages/world-sim/src/sim.ts:45-77`, `packages/world-sim/src/plan-math.ts:5-26`).

## Internal model

Graphs are undirected and edge lengths are Euclidean distances. `shortestPath` uses cached adjacency and route results per graph object (`packages/world-sim/src/graph.ts:17-34`, `packages/world-sim/src/graph.ts:41-49`).

## Dependencies

The map and movement code depends on the local graph, random ID, interpolation and type modules (`packages/world-sim/src/map.ts:1-2`, `packages/world-sim/src/sim.ts:1-4`).

## Gotchas

`WorldState.pos` stores plan endpoints immediately; rendering code that reads `pos` without interpolating the plan will display a destination jump (`packages/world-sim/src/sim.ts:58-63`, `packages/world-sim/src/plan-math.ts:5-26`). See [Gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [World simulation overview](../overview.md)
