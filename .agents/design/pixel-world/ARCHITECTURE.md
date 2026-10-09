---
title: Pixel World — living map of Lane Pilot
status: in progress
owner_decisions: "2026-10-10: the world is a live map of Lane Pilot work; the simulation ticks on the hub"
---

# Pixel World

The council office grows into a city that lives by its own rules and shows real Lane Pilot work.
Projects are districts, tasks are construction sites, writers are crews, a merge opens a building,
a red check knocks the scaffolding down and a repair crew arrives. Citizens around them follow needs and scenarios.

> [!NOTE]
> Decided by the owner on 2026-10-10: **live map of Lane Pilot** (not a decoration) and **simulation on the hub**
> (the world keeps ticking when no page is open; every viewer sees the same world).

## Problems in the office code today (0.1.220)

| Problem | Effect |
|---|---|
| People and cars GLB embedded as base64 in `app.js` (3 MB of 7.5 MB) | every Lane Pilot page downloads and parses them, even settings |
| ~2 000 separate meshes (each prop box is a draw call) | fine for one office, impossible for a city |
| Scene, props, behaviour, render and council logic in one room (`src/rooms/council/ui`, 7 k lines) | nothing reusable for a second building or a city |
| Behaviour runs in the browser per viewer | two viewers see different worlds; nothing happens while the page is closed |

## Target layout

```
packages/
  world-sim/          pure TypeScript, no three.js: the rules of the world
    clock, seeded rng, entities, needs, utility AI, scenario runner (JSON), jobs,
    construction stages, road/sidewalk graphs, protocol types (snapshot + events)
  pixel-world/        three.js client engine
    pixel pipeline (low-res target, depth outlines, toon 3 tones), camera (4 views, integer zoom),
    props kit, static batching + instancing, chunk streaming + LOD, asset loader (HTTP),
    actor renderer (GLB people/cars, clip mapping, interpolation of server plans)
src/rooms/world/
  server/             tick service on the hub, persistence (plugin DB), RPC snapshot, realtime/WebSocket events,
                      HTTP route for assets (/api/v1/plugins/lane-pilot/http/world/assets/*), Lane Pilot binding
  ui/                 the World page (city), the council office becomes one interior
assets/world/         GLB files served over HTTP, not bundled
```

## How time works

* The hub owns the world: a tick service steps `world-sim` at a low rate (decisions 1–2 Hz).
* Movement is sent as **plans**, not positions: `{actor, path, startAt, speed, clip}`. The client interpolates
  locally, so the hub sends a few events per second, not 60 frames.
* State persists in the plugin DB; on hub restart the sim catches up from `lastTickAt` in coarse steps.
* Clients load a snapshot (RPC), then follow events (realtime / WebSocket). Determinism (seeded rng, fixed
  step) keeps replays and tests exact.

## Lane Pilot binding

| Lane Pilot | World |
|---|---|
| project | district (plot set, colour, sign) |
| task (attempt) dispatched | construction site appears, surveyor marks it |
| writer working | crew builds: foundation → frame → walls → roof → paint (stage from attempt progress) |
| verification | inspector with a tablet walks the site |
| accepted / merged | building opens, people move in |
| failed check / blocked | scaffolding falls, repair crew arrives |
| self-repair thread | emergency service van |
| council session | meeting in the office (today's council room) |

## Economy (council cncl_cdc0a11174ac438c, 2026-10-10)

* **Income = accepted work, not tokens.** A district earns credits for each distinct accepted task (merge recorded in
  `lane_pilot_attempt_transition`), with a daily cap per district. Tokens are shown as the **cost** of construction:
  `total_tokens` includes cache reads (`src/rooms/usage/server/token-usage.ts`), and retries and long contexts inflate it,
  so tokens as income would reward waste.
* **Rules, event-driven.** Wages, prices, taxes, upkeep and inflation are formulas with fixed rates, settled on events
  (task accepted) and a daily settlement. The 1–2 Hz tick only moves figures.
* **Ledger.** Money is an append-only journal keyed by the source event id, so a hub restart or a replayed signal never
  pays twice.
* **Mayors.** A rule autopilot first (build what the budget allows by a priority table). An LLM mayor (free providers:
  OpenRouter `:free`, Groq, Gemini free tier, Workers AI, Cerebras — keys in Env Catalog, rotation, hourly call cap,
  cache, rule fallback) only after the autopilot ran without faults; it decides rare, flavourful things (what to build
  next, a daily decree), never balances.
* **MVP.** One district (BB-сервис), the «Город» screen behind a flag. Before enabling: p95 CPU/memory of the tick on the
  hub and a restart-recovery test.
* **Before any economy code:** a read-only reconciliation of token data, and the token-counter defect the council
  reported, handled as an incident fix.

## Feature freeze

The owner approved Pixel World as an exception to the 2026-10-07 freeze (2026-10-10): it is a separate module behind a
flag, off by default, and must not touch PM/writer paths. Engine optimisation ships as a stability improvement.

## Phases

1. **Engine split and performance** — extract `pixel-world` (verbatim moves first), static batching + instancing,
   assets over HTTP instead of base64, `world-sim` core + hub tick service skeleton with snapshot/events.
2. **City** — chunked districts generated from a seed, road graph with traffic, sidewalks with pedestrians,
   day/night, LOD for far chunks, no visible map edge.
3. **Life** — citizens with needs (energy, hunger, social, work), utility AI, JSON scenarios (daily routines, events).
4. **Construction** — building blueprints with stages, trucks delivering materials, crews, repairs.
5. **Binding** — Lane Pilot projects/tasks/attempts drive districts and sites live.
