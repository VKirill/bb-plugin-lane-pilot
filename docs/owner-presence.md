---
title: The owner at the keyboard
type: component
created: 2026-10-23
updated: 2026-10-25
status: active
confidence: medium
tags: [sma, presence, providers, accounts]
sources:
  - src/rooms/owner-presence/logic.ts
  - src/rooms/owner-presence/server/presence.ts
  - src/rooms/cockpit/ui/cockpit-page.tsx
  - src/rooms/cockpit/ui/screens-day.tsx
  - src/rooms/cockpit/ui/screens-ops.tsx
  - src/rooms/cockpit/ui/screens-work.tsx
  - src/rooms/cockpit/server.ts
---

# The owner at the keyboard

The factory must not take the account the owner is using. Lane Stack's hook `owner_presence.py` (UserPromptSubmit, every machine) writes
the time of each prompt the owner types in a Claude Code session of his own to `~/.agents/state/owner-presence.json`
(`{"claude-code": {"at", "host"}}`): never the prompt, nothing for a lane session (any LANE_* marker), `LANE_OWNER_PRESENCE=0` turns it off.

Every two minutes Lane Pilot reads that file on every connected machine (a machine that does not answer keeps its last marks). While the owner
used a provider within the last 10 minutes, a writer that would run on it is not spawned
(`writer_provider_unavailable:owner_present:…`, failure class `limit`): the writer chain moves to the next provider, as for an open breaker.
The subscription is one account across the machines, so the hold is global. `bb lane-pilot owner-presence` shows the marks.

Lane Pilot's own threads carry `LANE_PILOT_ROLE` (helpers on every provider; core `0.46.1-vk.4` or later keeps it under a required session policy) and its opening PM/self-repair prompt (`You are the Lane Pilot …`) is skipped by the hook, so they never mark the owner.

## How it works

1. Lane Stack writes per-provider owner-use timestamps to the host presence file; Lane Pilot polls connected machines every two minutes and keeps the last successfully read contents for each host (`src/rooms/owner-presence/server/presence.ts:14-21`).
2. `readPresence` ignores malformed JSON and invalid timestamp entries, then keeps the newest mark for each provider across hosts (`src/rooms/owner-presence/logic.ts:11-25`).
3. Before writer spawn, `presenceHold` returns a hold when a provider has a mark inside the ten-minute window; older or absent marks return no hold (`src/rooms/owner-presence/logic.ts:7-8`, `:27-32`).
4. The initial sweep is best-effort; scheduled sweep errors are logged, and a host that fails to answer keeps its last known mark (`src/rooms/owner-presence/server/presence.ts:14-20`, `:28-33`).

| State | Writer behavior |
|---|---|
| Recent owner mark | Holds that provider and lets the writer chain consider another provider (`src/rooms/owner-presence/logic.ts:27-32`). |
| No mark or mark outside the window | Does not hold the provider (`src/rooms/owner-presence/logic.ts:28-31`). |
| Invalid host file | Skips malformed content; previously read host content remains available (`src/rooms/owner-presence/logic.ts:14-21`, `src/rooms/owner-presence/server/presence.ts:16-20`). |

## Cockpit entry

The cockpit stores the selected project in browser local storage, loads the project screen state and latest active run, polls hub availability every 15 seconds, and renders the selected screen through the screen registry (`src/rooms/cockpit/ui/cockpit-page.tsx:11-47`, `:71-89`). `cockpitRpc` exposes project and screen reads, dashboard event subscriptions, owner waiting items, screen feedback, and cockpit control calls (`src/rooms/cockpit/server.ts:17-76`). Its Today, Forge and Phases screens are separate views backed by daily work, operations controls, and phase state (`src/rooms/cockpit/ui/screens-day.tsx:10-38`, `src/rooms/cockpit/ui/screens-ops.tsx:10-49`, `src/rooms/cockpit/ui/screens-work.tsx:14-35`).
