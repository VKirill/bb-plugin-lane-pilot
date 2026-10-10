---
title: World simulation gotchas
type: gotchas
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [world-sim, gotchas, state]
sources:
  - packages/world-sim/src/plan-math.ts
  - src/rooms/world/server/service.ts
  - packages/world-sim/src/world.ts
  - packages/world-sim/src/sim.ts
  - packages/world-sim/src/graph.ts
  - packages/world-sim/src/scenarios.ts
  - packages/world-sim/src/construction.ts
  - packages/world-sim/src/types.ts
  - packages/world-sim/tests/world.test.ts
---

# World simulation gotchas

TL;DR: The main integration traps are catch-up event loss, generated map omission from saves, endpoint positions in state, route fallback for disconnected graphs, and process-global scenario registration (`packages/world-sim/src/world.ts:120-147`, `packages/world-sim/src/sim.ts:49-63`).

## Critical

### Catch-up advances state but drops its events

**Problem:** `catchUp` clears its event buffer and returns `events: []` after advancing (`packages/world-sim/src/world.ts:120-135`).

**Risk:** An event-only client feed does not learn the catch-up changes from this call.

**Workaround:** Fetch a fresh snapshot after catch-up, as required by the `catchUp` contract (`packages/world-sim/src/world.ts:120-123`).

## High

### Serialized worlds omit the map

**Problem:** `serializeWorld` writes `map: undefined`, and `parseWorld` regenerates the map only after checking that the saved schema equals the current version (`packages/world-sim/src/world.ts:139-146`).

**Risk:** A schema mismatch throws; parsing saved JSON does not migrate an old shape (`packages/world-sim/src/world.ts:142-146`).

**Workaround:** Keep the state schema version aligned with the serialized shape and handle parse errors at the storage boundary (`packages/world-sim/src/types.ts:7-8`, `packages/world-sim/src/world.ts:142-146`).

### Actor positions in state are plan endpoints

**Problem:** `planTo` stores the path's final point in `actor.pos` when the plan is created; visual position requires `positionAt(plan, t)` (`packages/world-sim/src/sim.ts:54-63`, `packages/world-sim/src/plan-math.ts:5-26`).

**Risk:** A consumer drawing only `pos` renders an actor at its destination before travel finishes.

**Workaround:** Interpolate the actor plan at the display time using `positionAt` (`packages/world-sim/src/plan-math.ts:5-26`).

### Disconnected route fallback still creates a plan

**Problem:** `shortestPath` returns null when it cannot find a route, but `planTo` replaces that missing route with a direct destination node (`packages/world-sim/src/graph.ts:41-49`, `packages/world-sim/src/graph.ts:92-99`, `packages/world-sim/src/sim.ts:49-53`).

**Risk:** A broken graph can look like a valid plan and bypass graph connectivity.

**Workaround:** Validate graph connectivity when changing map construction; existing tests assert plot connectivity (`packages/world-sim/tests/world.test.ts:1-20`).

## Medium

### Registering a scenario changes the process registry

**Problem:** `registerScenario` writes into a module-level map keyed by scenario ID, replacing an existing entry; every world resolves its scenario IDs through that registry (`packages/world-sim/src/scenarios.ts:65-76`).

**Risk:** Registering an ID at runtime changes behavior for already-created worlds using that ID.

**Workaround:** Use unique scenario IDs when extending the registry (`packages/world-sim/src/scenarios.ts:65-72`).

### Open-site records are transient

**Problem:** An opened site's entity, task lookup and attempt lookups are deleted after 120 simulation seconds, while its building remains (`packages/world-sim/src/construction.ts:15`, `packages/world-sim/src/construction.ts:333-339`).

**Risk:** A later attempt lookup no longer resolves to the completed site.

**Workaround:** Consume the open event/building link before site cleanup, or resolve the durable building record (`packages/world-sim/src/construction.ts:246-259`, `packages/world-sim/src/construction.ts:333-339`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Citizen behavior](features/citizen-behavior.md)
- [Construction](features/construction.md)
- [Map and routing](features/map-and-routing.md)
- [Scenario engine](features/scenarios.md)
- [World runtime](features/world-runtime.md)
- [World simulation overview](overview.md)
