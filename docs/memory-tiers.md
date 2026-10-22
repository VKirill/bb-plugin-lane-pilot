---
title: Memory tiers — cold tier, episodes, misses
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, memory, cold-tier, episodes]
sources:
  - src/rooms/memory-tiers/server/tiers.ts
  - src/rooms/memory/server/memory.ts
---

# Memory tiers (SMA D2-8)

Around the PM's memory query (`lane_pilot_memory {action:"context"}`, `runMemoryContext`), three additions; the memory schema and its
write door are unchanged.

- **Cold tier — demotion instead of forgetting.** A note nobody was given for 90 days expires for idleness and leaves every brief, but it
  is kept. When a PM query finds fewer than three active notes, the expired notes without a date of their own are searched by the query's
  words; the best matches come back to the active corpus (re-indexed, used now) and are listed apart in the answer. Each comeback is a row
  of `lane_pilot_memory_promotion`: the share of the cold tier needed again is the measure of the 90-day rule.
- **Episodes.** Past tasks of the project whose title or objective share the query's words are added with how they ended (state and reason).
- **Real misses.** A query that found nothing — active, cold or episode — is a row of `lane_pilot_memory_miss`: a candidate question for the
  golden set of `memory-eval`.

`bb lane-pilot memory-tiers [--project P]`: the cold tier's size, the comebacks, the share needed again, the misses of 30 days.
