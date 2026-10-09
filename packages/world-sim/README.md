# @lane-pilot/world-sim

The rules of the Pixel World: a deterministic, serialisable simulation of a small city whose districts, building sites and
people follow Lane Pilot's real work. Pure TypeScript: no I/O, no clock, no three.js. The hub ticks it
(`src/rooms/world/server`); a browser only draws what it is told.

```ts
const world = createWorld(seed, { citizens: 24 });   // WorldState, plain JSON
const { events } = step(world, 0.5);                  // fixed 1 s sim steps, mutates `world`
applyLanePilotSignal(world, { type: "task_dispatched", projectId, taskId, attemptId });
catchUp(world, 3600, 30);                             // coarse steps after a stop; returns no events
const view = snapshot(world, { withMap: true });      // what a client needs
const json = serializeWorld(world);                   // without the map; parseWorld(json) regenerates it
```

Units: one world unit is one tile, `x` east, `z` south, the office block at the origin. Time is sim seconds; one game
hour is `config.hourSeconds` (default 120, so a day is 48 minutes). `hour`/`day` in a snapshot and in a batch are game time.

## Model

| Part | What it is |
|---|---|
| Map (`state.map`, static) | 3 x 3 blocks, 168 x 120 tiles: office block in the middle, residential, commercial, industrial (depot), park and four free blocks for project districts. `grid.tiles` is one digit per tile (0 grass, 1 road, 2 sidewalk, 3 plot, 4 office, 5 park). `sidewalk` and `road` are node/edge graphs; every plot has a door node, an entry node, slots and a `roadNode` where vehicles stop. |
| Citizens | needs (`energy hunger social fun work`, 1 = satisfied), a home, a workplace, a `plan`. Roles: `worker`, `builder`, `inspector`, `resident`. |
| Buildings, `pois` | a building owns points of interest (`desk`, `seat`, `bed`, `table`, `bench`, `shop`, `work` ...) with a clip to play there. The office points come from the real office layout. |
| Districts | one per Lane Pilot project, on a free block, with a colour and the project's name. |
| Sites | one per task: `stageIndex` 0..6 = `survey foundation frame walls roof paint open`, `progress` of the current stage, `target` (the highest stage the crew may work on), `collapsed`, `rejected`, `approved`. |
| Vehicles | `truck` (delivers a stage's materials), `van` (self-repair), `car` (ambient traffic). |

## Plans, not positions

An actor's movement is one `Plan`:

```ts
{ id, actorId, action, path: [{x,z}...], startAt, speed, arriveAt, until, clip, target?, lateral? }
```

Interpolate along `path` from `startAt` at `speed` units per sim second (`positionAt(plan, t)` does it, also exported from
`@lane-pilot/world-sim/protocol`), then play `clip` at the end until `until`. People walk (`walk`) and vehicles drive
(`drive`, `siren`); `lateral` shifts a vehicle's path to the right of its direction. An actor with no plan, or after
`until`, stands at the end of its last path. The first point of a path may lie between two nodes (a walk that was
taken over); all others are graph nodes and consecutive nodes share an edge. Clips used: `walk drive siren idle typing
sitting_table sitting_sofa chatting drinking operating window_gaze sleep eat shop hammer inspect stroll`.

## Protocol

`world_snapshot` (RPC) returns `{ snapshot, serverTime }`; `snapshot` is `WorldSnapshot`: `time, tick, hour, day, hourSeconds,
eventSeq, citizens, vehicles, buildings, pois, districts, sites, meetings`, plus `map` when `withMap` (ask once; it never
changes). A snapshot reflects every event up to `eventSeq`.

Events follow, in `seq` order, in batches `{ kind: "world", t, hour, day, firstSeq, lastSeq, events }` (at most two a second)
on the realtime channel `lp-world` (published only while some client has called an RPC in the last 90 s) or over the
WebSocket route `/api/v1/plugins/lane-pilot/http/world/stream` (the client sends `{type:"resume", afterSeq}`; the server
sends `hello`, batches and, when it no longer holds the events, `reset`: fetch a new snapshot). `world_events {afterSeq}`
returns what was missed or `reset: true`. A client skips events with `seq <= lastSeen`; if a batch starts beyond `lastSeen + 1` it asks `world_events` for the gap.

| Event | Meaning |
|---|---|
| `plan` | an actor got a new plan (replaces its old one) |
| `stage` | a site entered a stage (`stage`, `stageIndex`, `progress`) |
| `site` | `created delivered collapsed repaired rejected approved opened` |
| `district` | a district was created or renamed |
| `spawned` / `removed` | vehicle, building, site (citizens exist from the first snapshot); `removed` also for a pulled-down building |
| `meeting` | a council meeting `started` / `ended` with the citizens seated |
| `signal` | a Lane Pilot signal was applied (`applied`, `note` when it could not be) |

## Lane Pilot signals

`applyLanePilotSignal(state, signal)` maps work to the city; the whole table is `SIGNAL_RULES` in `src/binding.ts`.

| Signal | In the city |
|---|---|
| `project_upserted` | a district on a free block |
| `task_dispatched` | a site on a plot of the district; builders set out; the same task again reuses its site |
| `attempt_progress {percent}` | the crew may work up to the stage for that percent (never lowered) |
| `verification started / passed / failed` | the inspector walks to the site / approved / rejected |
| `accepted` | the crew is rushed, the building opens, people move in |
| `failed` | scaffolding collapses (one stage back), a repair crew comes, work goes on after |
| `self_repair_started` / `_ended` | an emergency van drives to the site and stays until it ends |
| `council_started` / `_ended` | staff sit down at the meeting table of the office and get up again |

When the city is out of free plots the oldest finished building is pulled down (`removed` / `building`).

## Scenarios

JSON in `src/scenarios/`, checked by `parseScenario`: `routines` (hours, citizen filter, `bias` or `force` an action) and
scripted `events` (hours, cooldown, conditions on `hour`, `sitesNeedingMaterials`, `openSites`, `idleCitizens`, `vehicles`,
`chance`; effects `delivery`, `spawn_traffic`, `damage_site`, `force_action`). Shipped: `morning-commute`, `lunch-rush`,
`evening-home`, `delivery` (on by default) and `storm` (off).

## Determinism and cost

The only randomness is `state.rng` (mulberry32 in the saved state); iteration order is insertion order. Same seed and the
same calls give the same state. 200 citizens step one sim hour in about 0.25 s (0.07 ms per step); 24 citizens in 0.01 ms;
a 24-hour catch-up at 30 s steps is about 0.5 s. The saved world is 38 KB for 24 citizens and 154 KB for 200.
Changing the map generator or the state shape means bumping `WORLD_SCHEMA_VERSION` (a saved world of another schema is replaced).
