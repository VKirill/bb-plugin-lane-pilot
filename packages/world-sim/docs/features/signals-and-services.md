---
title: Lane Pilot signals and city services
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: high
tags: [world-sim, signals, services]
sources:
  - packages/world-sim/src/index.ts
  - packages/world-sim/src/scenarios.ts
  - packages/world-sim/src/binding.ts
  - packages/world-sim/src/services.ts
  - packages/world-sim/src/types.ts
  - packages/world-sim/src/construction.ts
  - packages/world-sim/src/sim.ts
---

# Lane Pilot signals and city services

TL;DR: The signal adapter maps project, task, attempt, repair and council lifecycle messages into districts, construction sites, inspections, rescue vans, meetings and sequenced signal events (`packages/world-sim/src/binding.ts:29-84`).

## Purpose

`applyLanePilotSignal` is the inbound boundary from Lane Pilot into the model; every call emits a final `signal` event that records whether the rule applied and any reason it did not (`packages/world-sim/src/binding.ts:6-10`, `packages/world-sim/src/binding.ts:78-84`). Service helpers implement inspectors, rescue vans, meetings and ambient traffic (`packages/world-sim/src/services.ts:7-15`).

## How it works

1. The caller supplies one discriminated `LanePilotSignal`; the adapter looks up its rule and applies it against the mutable world (`packages/world-sim/src/types.ts:283-294`, `packages/world-sim/src/binding.ts:78-84`).
2. Project/task/progress/verification/accepted/failed signals delegate to district and site construction functions. Unknown attempt IDs return `unknown attempt`; an unavailable inspector returns `no free inspector` (`packages/world-sim/src/binding.ts:29-59`).
3. Self-repair chooses a target plot from the attempt, latest/collapsed project site, or office fallback; the rescue service sends a van from the depot and holds it until the explicit end signal or its maximum dwell (`packages/world-sim/src/binding.ts:20-27`, `packages/world-sim/src/services.ts:9-11`, `packages/world-sim/src/services.ts:38-60`).
4. Council start allocates free office staff first, then other non-builder citizens to available office seats; the end signal releases participants and removes meeting state (`packages/world-sim/src/services.ts:62-95`).
5. Each resulting event receives an incrementing sequence number and current simulation time (`packages/world-sim/src/sim.ts:11-13`).

### Event emission

`emit(sim, event)` receives a world event without `seq` and `t`, then pushes a copy with `seq` incremented from `sim.s.eventSeq` and `t` copied from current simulation time (`packages/world-sim/src/sim.ts:9-13`). It has no mode or validation branch: sequence advancement and append happen for every call. It returns `void`; if incrementing or pushing fails, the error propagates and there is no rollback or catch in this helper (`packages/world-sim/src/sim.ts:11-13`).

### Signal outcomes

| Signal group | State change | Failure note |
|---|---|---|
| `project_upserted`, `task_dispatched` | Create/update district or create/reuse task site (`packages/world-sim/src/binding.ts:29-37`). | Task creation reports no free plot (`packages/world-sim/src/binding.ts:34-37`). |
| `attempt_progress`, `verification`, `accepted`, `failed` | Raise work target, inspect/approve/reject, rush to open, or collapse for repair (`packages/world-sim/src/binding.ts:38-59`). | Unknown attempt; no free inspector; failed signal rejected if site is already down or finished (`packages/world-sim/src/binding.ts:15-18`, `packages/world-sim/src/binding.ts:43-59`). |
| `self_repair_started`, `self_repair_ended` | Spawn and return a rescue van (`packages/world-sim/src/binding.ts:60-67`). | No depot or unknown repair ID (`packages/world-sim/src/binding.ts:60-67`). |
| `council_started`, `council_ended` | Seat available participants, then release them (`packages/world-sim/src/binding.ts:68-75`). | No available participants or no matching meeting (`packages/world-sim/src/services.ts:65-74`, `packages/world-sim/src/services.ts:86-95`). |
| Inspector / traffic service calls | Assign an inspector job; spawn bounded road vehicles (`packages/world-sim/src/services.ts:19-36`, `packages/world-sim/src/services.ts:97-112`). | Inspector returns false when no eligible inspector exists; traffic stops spawning at the ambient-car cap (`packages/world-sim/src/services.ts:24-30`, `packages/world-sim/src/services.ts:101-110`). |

## Business rules

- Repeated `task_dispatched` for the same project/task reuses the existing site and binds another attempt ID (`packages/world-sim/src/construction.ts:84-90`, `packages/world-sim/src/construction.ts:110-113`).
- Rescue call IDs are idempotent while present in `state.calls`; ending an absent call returns false. A rescue stays up to 3,600 simulation seconds when no earlier end changes its plan (`packages/world-sim/src/services.ts:9-11`, `packages/world-sim/src/services.ts:38-60`).
- An inspector must have role `inspector`, no job and no sleep plan; an existing inspection job for the site makes `sendInspector` succeed without another job (`packages/world-sim/src/services.ts:19-35`).
- Meetings use an ID prefixed `m:`; duplicate starts succeed without creating another meeting. Requested attendance is bounded by seat count, and builders are excluded from non-office staff selection (`packages/world-sim/src/services.ts:62-83`).
- Ambient traffic creation is capped at 12 cars. `spawnTraffic` counts existing cars even when asked to spawn another vehicle kind (`packages/world-sim/src/services.ts:15`, `packages/world-sim/src/services.ts:97-111`).

## Public API

| Package export | File:line | Purpose |
|---|---|---|
| `applyLanePilotSignal`, `SIGNAL_RULES` | `packages/world-sim/src/binding.ts:29-84`, `packages/world-sim/src/index.ts:2` | Apply and inspect signal-to-city mappings. |
| `LanePilotSignal`, `SignalType`, `WorldEvent`, `WorldEventType`, `StepResult` | `packages/world-sim/src/types.ts:283-311`, `packages/world-sim/src/index.ts:12` | Signal input and event/result types. |

Service helper functions are internal and invoked by the adapter/scenario evaluator (`packages/world-sim/src/binding.ts:1-4`, `packages/world-sim/src/scenarios.ts:1-4`).

## Package shape

`binding.ts` owns the signal rule table and rescue target resolution; `services.ts` owns service jobs and their cleanup; construction operations are delegated (`packages/world-sim/src/binding.ts:15-27`, `packages/world-sim/src/binding.ts:29-76`, `packages/world-sim/src/services.ts:19-140`).

## Internal model

Signals mutate the same state model as autonomous behavior. State changes and animation plans are emitted as events in sequence so consumers can apply deltas after a snapshot (`packages/world-sim/src/sim.ts:11-13`, `packages/world-sim/src/types.ts:299-307`).

## Dependencies

This capability uses local construction, service and simulation helpers and shared state types (`packages/world-sim/src/binding.ts:1-4`).

## Gotchas

The adapter applies handlers directly to the supplied state and emits an outcome event; it does not clone state or implement rollback (`packages/world-sim/src/binding.ts:78-84`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [World simulation overview](../overview.md)
