---
title: Construction
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [world-sim, construction, projects]
sources:
  - packages/world-sim/src/construction.ts
  - packages/world-sim/src/types.ts
  - packages/world-sim/src/buildings.ts
  - packages/world-sim/src/world.ts
  - packages/world-sim/src/index.ts
  - packages/world-sim/src/binding.ts
---

# Construction

TL;DR: Project tasks claim plots as sites, advance through six work stages under externally supplied progress targets, and become buildings only when accepted and finished (`packages/world-sim/src/construction.ts:22-23`, `packages/world-sim/src/construction.ts:246-259`, `packages/world-sim/src/binding.ts:52-55`).

## Purpose

Construction maps project/task identity onto city districts, sites, jobs, material deliveries and completed buildings. Its state is held in `WorldState` records and plot indexes (`packages/world-sim/src/types.ts:137-184`, `packages/world-sim/src/types.ts:253-271`).

## How it works

1. A project signal creates or renames its district. A task signal reuses the prior site for the same `projectId/taskId` key, or claims a plot and creates a site (`packages/world-sim/src/construction.ts:29-47`, `packages/world-sim/src/construction.ts:84-107`).
2. Attempt IDs are bound to the site. Progress signals raise the site's target to the greatest mapped stage reached; a lower retry target does not undo progress (`packages/world-sim/src/construction.ts:110-120`).
3. Each update checks missing materials and creates deliveries, then creates build or repair jobs as required. Ready builders are assigned in nearest-first order (`packages/world-sim/src/construction.ts:272-300`, `packages/world-sim/src/construction.ts:222-245`).
4. Present crew members accumulate stage work. Stage completion emits an event and progresses toward the target. Acceptance sets target stage 6 and enables rush; after paint finishes, `openSite` creates a building and moves in eligible residents or workers (`packages/world-sim/src/construction.ts:302-331`, `packages/world-sim/src/construction.ts:246-269`, `packages/world-sim/src/binding.ts:52-55`).
5. A failed task collapses an unfinished site, moves it back one stage when at frame or later, ends its build job and schedules repair work (`packages/world-sim/src/construction.ts:122-131`, `packages/world-sim/src/construction.ts:283-300`).
6. Opened sites remain in state for 120 simulation seconds; cleanup then removes the site/task/attempt indexes while the building remains (`packages/world-sim/src/construction.ts:15`, `packages/world-sim/src/construction.ts:333-339`).

### Site and job branches

| State or branch | Rule/input | Output | Failure behavior |
|---|---|---|---|
| Site creation | Project/task/attempt IDs and optional title (`packages/world-sim/src/construction.ts:86-107`). | Selects blueprint deterministically from task ID; starts at survey with progress and target 0 (`packages/world-sim/src/construction.ts:93-100`). | Signal reports `no free plot for a new site` if no eligible plot can be claimed (`packages/world-sim/src/binding.ts:34-37`). |
| Material delivery | Missing stage materials and fewer than four trucks (`packages/world-sim/src/construction.ts:162-187`). | Truck travels depot → site, unloads, returns; delivery flag is set on arrival (`packages/world-sim/src/construction.ts:192-209`). | Delivery is not ordered at the truck cap; later updates retry (`packages/world-sim/src/construction.ts:174-187`, `packages/world-sim/src/construction.ts:272-283`). |
| Build | Current stage material delivered, site not collapsed, stage is within target (`packages/world-sim/src/construction.ts:214-219`). | Three builder crew slots; stage work uses `STAGE_WORK` seconds (`packages/world-sim/src/construction.ts:6-12`, `packages/world-sim/src/construction.ts:222-245`). | Crew assignment stops if no eligible builder is found; hungry or tired builders release their job (`packages/world-sim/src/construction.ts:220-235`, `packages/world-sim/src/construction.ts:295-300`). |
| Repair | Collapsed unfinished site | Two builders perform 120 crew-seconds of repair (`packages/world-sim/src/construction.ts:10-12`, `packages/world-sim/src/construction.ts:283-287`, `packages/world-sim/src/construction.ts:310-317`). | No builder leaves the repair job open for a later update (`packages/world-sim/src/construction.ts:222-235`). |
| Finished stage | Paint reaches 100% with target 6 | Opens building and releases build crew (`packages/world-sim/src/construction.ts:246-259`, `packages/world-sim/src/construction.ts:319-324`). | A paint-complete site with target below 6 remains at progress 1 until acceptance (`packages/world-sim/src/construction.ts:320-325`). |

### Plot claiming

`claimPlot` first searches for an unused plot in the district's block, then for any unused `free`-zone plot. If neither exists, it selects the oldest building created from a construction site, demolishes it and reuses its plot. If there is no such completed building, it returns `null` (`packages/world-sim/src/construction.ts:49-59`). Once a plot is selected, it removes the plot from its prior district's `plotIds`, updates `plotDistrict`, adds it to the new district, and returns it (`packages/world-sim/src/construction.ts:60-64`). Thus the only handled allocation failure is a full city with no demolishable site building; invalid district/plot indexes are not validated (`packages/world-sim/src/construction.ts:50-64`).

### Crew assignment

`assignCrews` visits requested jobs in order. It skips jobs whose site no longer exists, then fills each crew until `job.need` by scanning citizens for eligible builders and selecting the one nearest the site plot's top-left coordinates (`packages/world-sim/src/construction.ts:222-235`). Eligibility requires builder role, no job, no sleep plan, hunger above 0.2 and energy above 0.15 (`packages/world-sim/src/construction.ts:220-221`). If no candidate exists, the function returns immediately; the current job remains underfilled and later jobs in that pass are not visited (`packages/world-sim/src/construction.ts:228-235`). For each selected builder it releases the POI reservation, sets `jobId`, appends the crew ID, marks the job active, chooses a slot by crew index and sends a build/repair plan (`packages/world-sim/src/construction.ts:236-242`).

| Assignment condition | Outcome |
|---|---|
| Site missing | Skip that job (`packages/world-sim/src/construction.ts:224-226`). |
| Eligible candidates available | Pick nearest repeatedly until need is met; repair gets action `repair`, other jobs passed here get action `build` (`packages/world-sim/src/construction.ts:228-242`). |
| No eligible candidate | Return from the whole function; unfinished and subsequent jobs receive no more crew in this call (`packages/world-sim/src/construction.ts:228-235`). |

### Building creation

`addBuilding` assumes the requested plot exists, allocates a `bd` ID and chooses POI definitions by building kind. Offices and parks derive kinds/clips from plot slots; other kinds use `TEMPLATES` (`packages/world-sim/src/buildings.ts:19-25`). It walks each definition, skips a slot index with no corresponding plot slot, creates a POI ID from the building ID and current POI count, stores each POI and then stores the building (`packages/world-sim/src/buildings.ts:26-35`). It updates the plot-to-building index, increments `rev`, emits `spawned(building)` and returns the record (`packages/world-sim/src/buildings.ts:33-38`). There is no duplicate-occupancy or missing-plot validation. An absent plot fails when office/park slots or a non-empty template reads `plot.slots`; `warehouse` has an empty template and can be stored against the supplied plot ID without POIs. A missing individual slot in a non-empty definition is skipped (`packages/world-sim/src/buildings.ts:21-29`, `packages/world-sim/src/buildings.ts:5-15`).

### Opening a site

`openSite` sets `stageIndex` to 6, resets progress, stores `openedAt`, and creates the blueprint building on the site's plot with district and site provenance (`packages/world-sim/src/construction.ts:246-252`). It links the building back to the site, removes the active `plotSite` mapping, emits stage and opened-site events, finishes any build job, and assigns move-in residents/workers according to building kind (`packages/world-sim/src/construction.ts:252-259`). The helper has no guard for stage, approval, target or duplicate opening; callers gate it to completed paint with target 6 (`packages/world-sim/src/construction.ts:278-281`, `packages/world-sim/src/construction.ts:319-324`). A bad plot or building creation error propagates before later link/event updates, with no rollback (`packages/world-sim/src/construction.ts:246-258`).

## Business rules

- Percent maps to `floor(clampedPercent × 6)`, bounded to stages 0–5; `open` is stage 6 and is only reached through acceptance (`packages/world-sim/src/construction.ts:22-23`, `packages/world-sim/src/binding.ts:38-55`).
- A plot is free only when it has no building, site or district assignment (`packages/world-sim/src/construction.ts:27-28`). If all free plots are occupied, the oldest completed site building is demolished and its residents/workers are reassigned or released (`packages/world-sim/src/construction.ts:49-64`, `packages/world-sim/src/construction.ts:67-80`).
- Site progress targets are monotonic. A retry cannot lower the permitted stage target (`packages/world-sim/src/construction.ts:117-120`).
- Building work requires delivered materials and progress authority from the upstream target (`packages/world-sim/src/construction.ts:214-218`).
- Builder eligibility requires role `builder`, no current job, no sleep plan, hunger above 0.2 and energy above 0.15; assigned builders leave at hunger below 0.12 or energy below 0.1 (`packages/world-sim/src/construction.ts:220-221`, `packages/world-sim/src/construction.ts:295-300`).
- Failed verification marks a site rejected; accepted signals clear rejection, approve, enable rush and set the open target (`packages/world-sim/src/binding.ts:43-55`).

## Public API

| Package export | File:line | Purpose |
|---|---|---|
| `STAGE_WORK`, `STAGE_MATERIAL`, `targetForPercent` | `packages/world-sim/src/construction.ts:6-23`, `packages/world-sim/src/index.ts:3` | Work/material constants and progress mapping. |
| `STAGES`, `StageName`, `Site`, `Job`, `District`, `BuildingKind` | `packages/world-sim/src/types.ts:123-168`, `packages/world-sim/src/index.ts:12` | Public construction state types. |

The remaining construction functions are internal to the package root and are called by the runtime and signal adapter (`packages/world-sim/src/index.ts:1-12`, `packages/world-sim/src/world.ts:1-11`, `packages/world-sim/src/binding.ts:1-4`).

## Package shape

`construction.ts` owns district and site allocation, stage progression, delivery jobs, crews, repairs, opening and cleanup; `buildings.ts` creates the resulting building and POIs (`packages/world-sim/src/construction.ts:25-47`, `packages/world-sim/src/construction.ts:160-341`, `packages/world-sim/src/buildings.ts:19-38`).

## Internal model

A site links a Lane Pilot project, task and one or more attempts to a city plot. Task and attempt indexes support retries and later signals; jobs represent build, repair and delivery work rather than durable records (`packages/world-sim/src/types.ts:142-183`, `packages/world-sim/src/types.ts:267-271`).

## Dependencies

Construction uses local building, seeded ID and hash helpers, simulation events and plans, and shared types (`packages/world-sim/src/construction.ts:1-4`).

## Gotchas

A completed site is cleaned up while its created building remains. Consumers that need the site-to-building relation must use it before cleanup (`packages/world-sim/src/construction.ts:333-339`). See [Gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [World simulation overview](../overview.md)
