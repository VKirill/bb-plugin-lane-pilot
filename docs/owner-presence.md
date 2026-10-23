---
title: The owner at the keyboard
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, presence, providers, accounts]
sources:
  - src/rooms/owner-presence/logic.ts
  - src/rooms/owner-presence/server/presence.ts
---

# The owner at the keyboard (SMA D2-6: «Daytime owner left alone», «Busy account skipped»)

The factory must not take the account the owner is using. Lane Stack's hook `owner_presence.py` (UserPromptSubmit, every machine) writes
the time of each prompt the owner types in a Claude Code session of his own to `~/.agents/state/owner-presence.json`
(`{"claude-code": {"at", "host"}}`): never the prompt, nothing for a lane session (any LANE_* marker), `LANE_OWNER_PRESENCE=0` turns it off.

Every two minutes Lane Pilot reads that file on every connected machine (a machine that does not answer keeps its last marks). While the owner
used a provider within the last 10 minutes, a writer that would run on it is not spawned
(`writer_provider_unavailable:owner_present:…`, failure class `limit`): the writer chain moves to the next provider, as for an open breaker.
The subscription is one account across the machines, so the hold is global. `bb lane-pilot owner-presence` shows the marks.

Lane Pilot's own threads carry `LANE_PILOT_ROLE` (helpers on every provider; core `0.46.1-vk.4` or later keeps it under a required session policy) and its opening PM/self-repair prompt (`You are the Lane Pilot …`) is skipped by the hook, so they never mark the owner.
