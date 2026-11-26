---
title: Outage record and the conveyor switch
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, outage, conveyor, hub]
sources:
  - src/rooms/outage
  - src/rooms/runs/server/services/conveyor.ts
  - src/rooms/runs/models/conveyor.ts
  - packages/workflow-engine/src/engine-clock.ts
---

# Outage record and the conveyor switch (SMA D2-10)

**Outages.** `outage:beat` records a heartbeat in plugin storage on each `engine-clock` beat (`CLOCK_BEAT_MS = 60_000`, `packages/workflow-engine/src/engine-clock.ts`). At start, a last beat older than five minutes is recorded as an
outage (`lane_pilot_outage`: from, to, minutes): the hub was down or the plugin was not loaded. A deploy reload is seconds and stays under
the threshold. A plugin cannot announce its own fall while it is down; the outage is reported when it runs again: one line in the daily report
(`Простои Lane Pilot: …`) and `bb lane-pilot outages [--days 7]`.

**Conveyor.** `bb lane-pilot conveyor off [reason] | on | status`, RPC `conveyor` (`src/rooms/runs/server/services/conveyor.ts`). Off, no new work is issued anywhere: a task waits before
it takes a writer slot exactly as in a paused run (`isHeld`), parked tasks are not restarted, and new dispatches wait. Already-running stages
and checks finish cleanly. A run's own pause is a separate flag and stays as it was.
