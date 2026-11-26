---
title: The owner at the keyboard
type: component
created: 2026-10-23
updated: 2026-10-25
status: active
confidence: medium
tags: [sma, presence, providers, accounts]
sources:
  - src/rooms/owner-presence/models/presence.ts
  - src/rooms/owner-presence/server/services/presence-service.ts
---

# The owner at the keyboard

The factory must not take the account the owner is using. Lane Stack's hook `owner_presence.py` (UserPromptSubmit, every machine) writes
the time of each prompt the owner types in a Claude Code session of his own to `~/.agents/state/owner-presence.json`
(`{"claude-code": {"at", "host"}}`): never the prompt, nothing for a lane session (any `LANE_*` marker); `LANE_OWNER_PRESENCE=0` turns it off.

Lane Pilot reads that file on connected machines (`src/rooms/owner-presence/server/services/presence-service.ts`). While the owner
used a provider within the last 10 minutes, a writer that would run on it is not spawned
(`writer_provider_unavailable:owner_present:…`, failure class `limit`): the writer chain moves to the next provider, as for an open breaker.
The subscription is one account across the machines, so the hold is global. `bb lane-pilot owner-presence` shows the marks.

Lane Pilot's own threads carry `LANE_PILOT_ROLE` and its opening PM prompt (`You are the Lane Pilot …`) is skipped by the hook, so they never mark the owner.

## How it works

1. Lane Stack writes per-provider owner-use timestamps to the host presence file; Lane Pilot reads connected machines and keeps the last successfully read contents for each host (`src/rooms/owner-presence/server/services/presence-service.ts`).
2. `readPresence` ignores malformed JSON and invalid timestamp entries, then keeps the newest mark for each provider across hosts (`src/rooms/owner-presence/models/presence.ts`).
3. Before writer spawn, `presenceHold` returns a hold when a provider has a mark inside the ten-minute window; older or absent marks return no hold (`src/rooms/owner-presence/models/presence.ts`).

| State | Writer behavior |
|---|---|
| Recent owner mark | Holds that provider and lets the writer chain consider another provider (`src/rooms/owner-presence/models/presence.ts`). |
| No mark or mark outside the window | Does not hold the provider. |
| Invalid host file | Skips malformed content; previously read host content remains available. |
