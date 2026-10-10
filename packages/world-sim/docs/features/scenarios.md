---
title: Scenario engine
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [world-sim, scenarios, simulation]
sources:
  - packages/world-sim/src/world.ts
  - packages/world-sim/src/index.ts
  - packages/world-sim/src/scenarios.ts
  - packages/world-sim/src/construction.ts
  - packages/world-sim/src/services.ts
  - packages/world-sim/src/sim.ts
  - packages/world-sim/src/types.ts
  - packages/world-sim/src/scenarios/morning-commute.json
  - packages/world-sim/src/scenarios/lunch-rush.json
  - packages/world-sim/src/scenarios/evening-home.json
  - packages/world-sim/src/scenarios/storm.json
  - packages/world-sim/src/scenarios/delivery.json
---

# Scenario engine

TL;DR: Scenarios are validated JSON routines and scripted events that bias or force citizen actions, or apply deliveries, traffic, damage and temporary action overrides (`packages/world-sim/src/scenarios.ts:14-17`, `packages/world-sim/src/scenarios.ts:36-63`, `packages/world-sim/src/scenarios.ts:121-149`).

## Purpose

This capability keeps schedule variation in data files while evaluating routines and events against the serializable world state (`packages/world-sim/src/scenarios.ts:8-16`, `packages/world-sim/src/types.ts:189-229`).

## How it works

1. `parseScenario` validates an unknown document's ID, routines, event conditions and effects. Routine/event arrays default to empty when absent (`packages/world-sim/src/scenarios.ts:36-63`).
2. `registerScenario` parses and stores a document in a module-level registry; imported JSON scenarios register at module load (`packages/world-sim/src/scenarios.ts:65-74`).
3. The world config selects active scenario IDs. Routine checks match hour ranges and citizen filters; `bias` adds utility and `force` requests an action subject to chance (`packages/world-sim/src/scenarios.ts:76-105`).
4. Every 15 simulation seconds, the world tick runs scripted event evaluation. It drops expired forced actions, checks hours, cooldowns and conditions, records firing time, then applies effects in order (`packages/world-sim/src/world.ts:19-20`, `packages/world-sim/src/world.ts:94-97`, `packages/world-sim/src/scenarios.ts:137-149`).
5. Effects can trigger a delivery, spawn traffic, damage an unfinished site, or add a temporary forced action (`packages/world-sim/src/scenarios.ts:121-135`).

### Effect application

The private `apply(sim, effect)` reads `sim.s` and branches on the validated effect type; it mutates the world or delegates to construction/service helpers and returns no status (`packages/world-sim/src/scenarios.ts:121-135`).

| Effect | Steps and branch conditions | Outcome and no-op/failure behavior |
|---|---|---|
| `delivery` | Find sites needing materials, sort oldest first, then ask for the next missing stage with look-ahead (`packages/world-sim/src/scenarios.ts:124-127`). | If a site and missing stage exist, call `orderDelivery`; no site/stage or a rejected order (including truck-cap refusal) produces no effect-level result or event indicating failure (`packages/world-sim/src/scenarios.ts:127-129`, `packages/world-sim/src/construction.ts:174-187`). |
| `spawn_traffic` | Default kind to `car` and count to 1 when fields are absent (`packages/world-sim/src/scenarios.ts:131`). | Delegate to `spawnTraffic`; it can create fewer than requested when the car cap is reached, and `apply` discards the returned count (`packages/world-sim/src/services.ts:97-112`). |
| `damage_site` | Choose an eligible random site (`packages/world-sim/src/scenarios.ts:132`). | If a site exists, call `damageSite`; no eligible site is a no-op, and an already collapsed or finished site is rejected by `damageSite` (`packages/world-sim/src/construction.ts:122-131`, `packages/world-sim/src/construction.ts:343-346`). |
| `force_action` | Use the optional citizen filter or null and set expiry to current sim time plus `forHours` converted to seconds (`packages/world-sim/src/scenarios.ts:133`, `packages/world-sim/src/sim.ts:18`). | Append the override to `scenario.forced`; expired entries are removed by event evaluation (`packages/world-sim/src/scenarios.ts:137-142`). |

Scenario parsing rejects unsupported effect types and validates `force_action` action and duration before runtime application (`packages/world-sim/src/scenarios.ts:54-60`). The other effect-specific payloads are cast to their declared types during parsing rather than fully validated; helper exceptions propagate from `apply` (`packages/world-sim/src/scenarios.ts:54-57`, `packages/world-sim/src/scenarios.ts:121-135`).

### Modes and shipped scenarios

| Mode/scenario | Inputs and conditions | Effect |
|---|---|---|
| Routine `bias` | `action`, hour range, optional citizen filter and weight | Adds weight to action utility for matching citizens (`packages/world-sim/src/scenarios.ts:89-95`). |
| Routine `force` | Same filters, plus optional chance | Returns the requested action when its chance succeeds (`packages/world-sim/src/scenarios.ts:98-105`). |
| `morning-commute` | 06:30–09:00, working citizens, 0.9 chance; traffic event 07:00–09:00, 0.4-hour cooldown | Forces work and spawns up to three cars per event (`packages/world-sim/src/scenarios/morning-commute.json:1-10`). |
| `lunch-rush` | Worker meal routine 12:00–13:30; resident park bias 12:00–14:00; park force event | Encourages cafe trips and resident park actions (`packages/world-sim/src/scenarios/lunch-rush.json:1-11`). |
| `evening-home` | Routine range 18:00–22:00 | Forces some rest trips and biases dinner at home (`packages/world-sim/src/scenarios/evening-home.json:1-9`). |
| `delivery` | 08:00–17:00, pending material need, 0.6 chance, 0.5-hour cooldown | Orders the next missing materials for the oldest waiting site (`packages/world-sim/src/scenarios/delivery.json:1-14`, `packages/world-sim/src/scenarios.ts:124-129`). |
| `storm` | Any hour, at least one open site, 0.12 chance, six-hour cooldown | Damages a random eligible site. It is registered but excluded from defaults (`packages/world-sim/src/scenarios/storm.json:1-8`, `packages/world-sim/src/scenarios.ts:71-74`). |

**Failure behavior:** Invalid required fields throw an error naming the scenario location. Unknown IDs in `config.scenarios` are filtered out of the active set, so no events or routines run for them (`packages/world-sim/src/scenarios.ts:23-24`, `packages/world-sim/src/scenarios.ts:36-62`, `packages/world-sim/src/scenarios.ts:76`).

## Business rules

- Hour ranges are half-open `[from,to)`; ranges crossing midnight match hours after `from` or before `to` (`packages/world-sim/src/scenarios.ts:26-29`, `packages/world-sim/src/scenarios.ts:78-79`).
- Routine actions are restricted to `CHOSEN_ACTIONS`; scripted `force_action` uses the same set (`packages/world-sim/src/scenarios.ts:31-34`, `packages/world-sim/src/scenarios.ts:54-57`).
- Valid condition facts are `hour`, `sitesNeedingMaterials`, `openSites`, `idleCitizens`, `vehicles` and `chance`; non-chance facts require one of `<`, `<=`, `>`, `>=`, `==` (`packages/world-sim/src/scenarios.ts:19-21`, `packages/world-sim/src/scenarios.ts:49-53`).
- An event needs at least one effect; missing routines or events are treated as empty arrays (`packages/world-sim/src/scenarios.ts:39-40`, `packages/world-sim/src/scenarios.ts:54-60`).
- Default active IDs are morning commute, lunch rush, evening home and delivery (`packages/world-sim/src/scenarios.ts:71-74`).

## Public API

| Package export | File:line | Purpose |
|---|---|---|
| `parseScenario`, `registerScenario`, `DEFAULT_SCENARIOS`, `listScenarios` | `packages/world-sim/src/scenarios.ts:36-77`, `packages/world-sim/src/index.ts:8` | Validate, register and list scenario documents and default IDs. |
| `Scenario`, `Routine`, `ScriptedEvent`, `Condition`, `Effect`, `CitizenFilter`, `HourRange` | `packages/world-sim/src/types.ts:189-229`, `packages/world-sim/src/index.ts:12` | Scenario document and filter types. |

## Package shape

`scenarios.ts` imports the five JSON documents, validates/registers them, and contains the runtime evaluator (`packages/world-sim/src/scenarios.ts:8-12`, `packages/world-sim/src/scenarios.ts:36-149`).

## Internal model

Runtime cooldowns and temporary forced actions live in `WorldState.scenario`, separate from immutable registered scenario documents (`packages/world-sim/src/types.ts:224-229`, `packages/world-sim/src/types.ts:276`).

## Dependencies

Effects delegate to construction and service helpers; selection consumes the world RNG and reads the world clock (`packages/world-sim/src/scenarios.ts:1-4`).

## Gotchas

Registry state is process-global, while active scenario IDs are per-world config. Registering the same ID replaces the prior document for every world in the process (`packages/world-sim/src/scenarios.ts:65-72`). See [Gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [World simulation overview](../overview.md)
