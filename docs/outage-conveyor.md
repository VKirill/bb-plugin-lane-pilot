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
  - src/rooms/conveyor/logic.ts
---

# Outage record and the conveyor switch (SMA D2-10)

**Outages.** The plugin writes a heartbeat into its key-value store once a minute. At start, a last beat older than five minutes is an
outage (`lane_pilot_outage`: from, to, minutes): the hub was down or the plugin was not loaded. A deploy reload is seconds and stays under
the threshold. A plugin cannot announce its own fall while it is down; the outage is told when it runs again: one line in the daily report
(`Простои Lane Pilot: …`) and `bb lane-pilot outages [--days 7]`.

**Conveyor.** `bb lane-pilot conveyor off [reason] | on | status`, RPC `conveyor`. Off, no new work is issued anywhere: a task waits before
it takes a writer slot exactly as in a paused run (`isHeld`), parked tasks are not restarted, the night loop queues nothing. Running stages
finish and every check goes on (run goal, capabilities, regression). A run's own pause is a separate flag and stays as it was.
