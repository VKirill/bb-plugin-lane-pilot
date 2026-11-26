---
title: The lead («Штурман»)
type: component
created: 2026-11-01
updated: 2026-11-26
status: active
confidence: medium
tags: [lead, owner, road, tick]
sources:
  - src/rooms/lead/migrations.ts
  - src/rooms/lead/identity.ts
  - src/rooms/lead/models/identity.ts
  - src/rooms/lead/models/tick.ts
  - src/rooms/lead/models/nearest.ts
  - src/rooms/lead/models/surfaces.ts
  - src/rooms/lead/models/lead-schedule.ts
  - src/rooms/contracts/lead-agent.ts
  - src/rooms/lead/server/services/surfaces.ts
  - src/rooms/lead/server/repositories/road-repository.ts
  - src/rooms/lead/server/repositories/tick-repository.ts
  - src/rooms/lead/server/services/tick-service.ts
  - src/rooms/lead/server/handlers/tick-actions.ts
  - src/rooms/lead/server/services/nearest.ts
  - src/rooms/lead/server/services/sweeps.ts
  - src/rooms/lead/server/services/lead-schedule.ts
  - src/rooms/lead/server/handlers/lead-tool.ts
  - src/rooms/schedule/server/services/system-schedules.ts
  - workflows/lead-tick.json
  - packages/models/src/role-models.ts
---

> [!note] Current scope
> The lead room keeps its identity file (`LEAD.md`), road tree (`lane_pilot_lead_road`), tick workflow (`workflows/lead-tick.json`), schedule creation helper, and nearest-unit ladder (`nearest.ts`, feeding `lp.evolve`). The earlier decision journal, nightly exam, rights table (`lane_pilot_lead_right`, `policy/lead-policy.json`), labels, backtest, memory exam, `ROAD.md` export, and `lead-section.tsx` UI panel were removed.

# The lead («Штурман»)

TL;DR: one persona above every project of the owner. It keeps a road tree (`lane_pilot_lead_road`: directions, options, states), runs `lead-tick` on the project schedule board (`PROJECT_SCHEDULES`), scores repeated graphless errands via the nearest-unit ladder (`nearest.ts`), and writes branches/proposals to the road tree without editing code or dispatching writers directly.

## The pieces

| Piece | Table / file | What it is |
|---|---|---|
| Road tree | `lane_pilot_lead_road`, `src/rooms/lead/server/repositories/road-repository.ts` | directions and options with a reason and evidence; states `open \| proposed \| accepted \| later \| rejected \| done`; a rejected branch keeps its reason |
| Identity | `~/.lane-pilot/lead/LEAD.md`, `src/rooms/lead/identity.ts`, `src/rooms/lead/models/identity.ts` | the owner's text read at tick and chat start, delivered as `<lead_identity sha=…>`, seeded with a default on first read |
| Tick & schedule | `lane_pilot_lead_tick`, `workflows/lead-tick.json`, `src/rooms/lead/server/services/tick-service.ts`, `src/rooms/lead/server/handlers/tick-actions.ts` | per-project `lead-tick` row in `PROJECT_SCHEDULES` (`src/rooms/schedule/server/services/system-schedules.ts:70-82`) and `lane_pilot_lead_tick` receipt |
| Nearest ladder | `src/rooms/lead/server/services/nearest.ts`, `src/rooms/lead/models/nearest.ts` | groups repeated graphless errands in the last 30 days and attaches nearest catalog units for `lead-tick` / `lp.evolve` |
| Lead schedules | `src/rooms/lead/server/services/lead-schedule.ts` | validates and creates `schedule` proposals via `services.schedules.save` (`by: lead:...`) |

## A tick (`workflows/lead-tick.json`)

1. `lp.lead_state` (`tick-service.ts`): builds `hubSnapshot` across projects in the lead's zone (`WINDOW = 12` rotating across ticks), open road branches, waiting owner items, recent ticks, and `graphlessErrands` enriched with `attachNearest` (`src/rooms/lead/server/services/tick-service.ts`).
2. `think`: agent step running as role `lead` answering with `summary`, `proposals`, `branches`, `deferred`, and `status`.
3. `lp.lead_propose` / `lp.lead_receipt` (`tick-actions.ts`): writes accepted branch updates to `lane_pilot_lead_road` and records the tick receipt (`ok | off | budget | error | no_receipt`). Sweeps close timed-out ticks (`src/rooms/lead/server/services/sweeps.ts`).

## Chat profile & tool

The profile `lead` (`src/rooms/contracts/lead-agent.ts`) opens a read-only chat with the typed tool `lane_pilot_lead` (`src/rooms/lead/server/handlers/lead-tool.ts`). It never writes to repositories, dispatches writers, or posts directly to PM chats.
