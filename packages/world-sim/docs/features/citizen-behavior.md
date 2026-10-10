---
title: Citizen behavior
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [world-sim, citizens, behavior]
sources:
  - packages/world-sim/src/index.ts
  - packages/world-sim/src/world.ts
  - packages/world-sim/src/plan-math.ts
  - packages/world-sim/src/ai.ts
  - packages/world-sim/src/types.ts
  - packages/world-sim/src/buildings.ts
  - packages/world-sim/src/sim.ts
  - packages/world-sim/src/scenarios.ts
---

# Citizen behavior

TL;DR: Citizens lose satisfaction in five needs, then choose an available destination by need utility, schedule biases, travel cost and seeded randomness (`packages/world-sim/src/ai.ts:28-40`, `packages/world-sim/src/ai.ts:105-131`).

## Purpose

The AI module updates needs and plans the next autonomous action for citizens that are not held by a construction job or meeting (`packages/world-sim/src/ai.ts:27-40`, `packages/world-sim/src/world.ts:98-108`). Citizen state stores role, home, workplace, needs, current plan and soft POI reservation (`packages/world-sim/src/types.ts:89-109`).

## How it works

1. `updateNeeds` converts elapsed simulation seconds to game hours, applies per-hour decay, adds the restoration for the action after its plan arrival, then clamps every need to `[0,1]` (`packages/world-sim/src/ai.ts:28-40`).
2. `decide` releases the citizen's previous POI reservation, computes action weights from current needs and hour, and asks scenario routines for a bias or forced action (`packages/world-sim/src/ai.ts:106-123`).
3. The candidate lookup chooses POIs by action and time: workplaces for work, cafes/home/office kitchen for meals, home beds or sofas for rest, and cafes/office/park/shop points for social and leisure actions (`packages/world-sim/src/ai.ts:81-99`).
4. For each candidate, `best` scores distance plus POI load and seeded noise. The selected option reserves its POI and creates a sidewalk plan with a randomized dwell (`packages/world-sim/src/ai.ts:58-67`, `packages/world-sim/src/ai.ts:114-130`, `packages/world-sim/src/buildings.ts:66-77`).
5. If no action has a candidate POI, the citizen receives a quiet 30-second wait plan (`packages/world-sim/src/ai.ts:121-124`).

### Tick order and branches

`tick(sim, dt)` is the internal unit of world advancement. It mutates the same state and appends subsystem events to the tick-local event list (`packages/world-sim/src/world.ts:88-109`).

1. Add `dt` to simulation time and increment the tick counter; derive the current game hour from the updated time (`packages/world-sim/src/world.ts:90-93`).
2. Update needs for every citizen using the same `dt` and hour (`packages/world-sim/src/world.ts:94`).
3. If at least 15 simulation seconds have passed since the prior scenario check, set `lastCheck` to the current time and run scripted events (`packages/world-sim/src/world.ts:19-20`, `packages/world-sim/src/world.ts:95`).
4. Advance construction, then service jobs (`packages/world-sim/src/world.ts:96-97`).
5. For each citizen, a non-null `jobId` holds autonomous choice. If the citizen has arrived at a build, repair or meeting plan whose `until` is within five seconds, renew the plan for six game hours at the current sidewalk node; then skip decision selection (`packages/world-sim/src/world.ts:98-105`).
6. Citizens without jobs call `decide` when they have no plan or their current plan has expired (`packages/world-sim/src/world.ts:106-108`).

| Branch | Condition | Outcome |
|---|---|---|
| Scenario check | `s.time - lastCheck >= 15` | Evaluate scripted events and update `lastCheck`; otherwise keep scenario runtime unchanged this tick (`packages/world-sim/src/world.ts:19-20`, `packages/world-sim/src/world.ts:95`). |
| Assigned citizen | `jobId` is truthy | Build/repair/meeting plans get renewed only after arrival and near expiry; all assigned citizens skip `decide` (`packages/world-sim/src/world.ts:98-105`). |
| Unassigned citizen | No job and missing or expired plan | Run `decide`; an unexpired plan remains in place (`packages/world-sim/src/world.ts:106-108`). |

`tick` has no local catch or rollback branch. Errors from need updates, scenario events, construction, services or decision-making propagate to its caller (`packages/world-sim/src/world.ts:89-109`). `step` also propagates them; it only returns the state and events after its fixed-step loop completes (`packages/world-sim/src/world.ts:111-118`).

### Plan position interpolation

`positionAt(plan, t)` returns `{x,z,heading,phase}` for a plan time, with phase `wait`, `move` or `dwell` (`packages/world-sim/src/plan-math.ts:3-6`). Its branch order is:

1. A path with fewer than two points, or any time at/after `arriveAt`, returns the last point with phase `dwell` (`packages/world-sim/src/plan-math.ts:7-13`).
2. Before or at `startAt`, return the first point and first-segment heading with phase `wait` (`packages/world-sim/src/plan-math.ts:14`, `packages/world-sim/src/plan-math.ts:29-32`).
3. During travel, compute remaining distance as elapsed simulation seconds times speed; subtract each segment length until the containing segment is found, then linearly interpolate position and derive heading from that segment (`packages/world-sim/src/plan-math.ts:15-23`). A zero-length segment uses its endpoint (`packages/world-sim/src/plan-math.ts:18-21`).
4. If iteration falls through, return the last point with phase `dwell` (`packages/world-sim/src/plan-math.ts:24-26`).

The function does not validate `path`. An empty path reaches an undefined `last` point and fails while reading its coordinates (`packages/world-sim/src/plan-math.ts:7-12`).

### Action branches

| Action | Candidate destination | Need restoration while at destination | Dwell / special case |
|---|---|---|---|
| `work` | Dedicated desk, else workplace work POIs (`packages/world-sim/src/ai.ts:83-86`). | Work `+0.5` per game hour (`packages/world-sim/src/ai.ts:10-22`). | 3–4.5 game hours; omitted when no workplace (`packages/world-sim/src/ai.ts:101-103`, `packages/world-sim/src/ai.ts:112-114`). |
| `eat` | Day: cafes, office kitchen and home; evening: home and cafes before 21:00 (`packages/world-sim/src/ai.ts:87-93`). | Hunger `+1.4` per game hour (`packages/world-sim/src/ai.ts:10-22`). | 0.4–0.7 game hours (`packages/world-sim/src/ai.ts:101-103`). |
| `rest` | Home sofa by day, bed from 21:00 through 05:59 (`packages/world-sim/src/ai.ts:94`). | Energy `+0.12` for rest, `+0.23` for sleep per game hour (`packages/world-sim/src/ai.ts:10-22`). | 0.8–1.5 game hours; sleep instead uses 3–9 hours bounded toward 07:00 (`packages/world-sim/src/ai.ts:101-103`, `packages/world-sim/src/ai.ts:125-128`). |
| `chat`, `park`, `shop` | Chat points across cafes, office and park; park benches/strolls; shop POIs (`packages/world-sim/src/ai.ts:95-98`). | Values are in `RESTORE_PER_HOUR` (`packages/world-sim/src/ai.ts:10-22`). | Respectively 0.3–0.6, 0.7–1.4 and 0.4–0.8 game hours (`packages/world-sim/src/ai.ts:101-103`). |

There is no thrown failure path for an absent destination: the option is omitted; if all options are absent the citizen waits. POI selection and action tie-breaking consume the saved random stream (`packages/world-sim/src/ai.ts:58-65`, `packages/world-sim/src/ai.ts:112-124`).

## Business rules

- Needs are satisfaction values: decay and restoration are rates per game hour; `work` decays only for citizens with a workplace during 08:00–18:00 (`packages/world-sim/src/ai.ts:7-8`, `packages/world-sim/src/ai.ts:25-39`).
- Energy decay continues during sleep at 30% rate; the other non-work need decay rates also use that slow factor (`packages/world-sim/src/ai.ts:33-39`).
- A citizen without `workId` is not offered the autonomous work action (`packages/world-sim/src/ai.ts:112-114`).
- POI load is a soft reservation count incremented on selection and decremented when released; it contributes to destination scoring (`packages/world-sim/src/buildings.ts:66-77`, `packages/world-sim/src/ai.ts:58-65`).
- The clock and unit conversion come from the world config, so all action durations are game hours converted into simulation seconds (`packages/world-sim/src/sim.ts:15-18`, `packages/world-sim/src/ai.ts:124-130`).

## Public API

The package root does not re-export `decide` or `updateNeeds`; they are runtime internals called from `world.ts` (`packages/world-sim/src/index.ts:1-12`, `packages/world-sim/src/world.ts:1-11`). Public citizen-related types and action constants come from the wildcard type export (`packages/world-sim/src/types.ts:13-22`, `packages/world-sim/src/index.ts:12`).

| Package export | File:line | Purpose |
|---|---|---|
| `NeedKey`, `Needs`, `ActionKind`, `ChosenAction`, `CitizenRole`, `Citizen` | `packages/world-sim/src/types.ts:13-22`, `packages/world-sim/src/types.ts:89-109` | Need keys, action names and citizen shape. |
| `Plan`, `Vec` | `packages/world-sim/src/types.ts:9-10`, `packages/world-sim/src/types.ts:24-45` | Movement plan and coordinates. |

## Package shape

`ai.ts` owns utility and needs; `buildings.ts` owns POIs and reservations; `scenarios.ts` supplies routine bias and forced action; `sim.ts` makes movement plans (`packages/world-sim/src/ai.ts:1-5`).

## Internal model

The action score starts with a need and hour weight, adds scenario bias, subtracts half the travel time in game hours, then adds small random variation. Destination score uses distance, current POI load and additional seeded noise (`packages/world-sim/src/ai.ts:44-56`, `packages/world-sim/src/ai.ts:58-65`, `packages/world-sim/src/ai.ts:114-120`).

## Dependencies

This capability uses local building, scenario, RNG and simulation helpers (`packages/world-sim/src/ai.ts:1-5`).

## Gotchas

A plan sets `actor.pos` to its destination endpoint immediately; clients derive the displayed position from the plan and simulation time (`packages/world-sim/src/sim.ts:45-63`, `packages/world-sim/src/plan-math.ts:5-26`). See [Gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [World simulation overview](../overview.md)
