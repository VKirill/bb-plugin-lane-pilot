---
title: Memory tiers (SMA D2-8)
type: component
created: 2026-10-23
updated: 2026-10-28
status: active
confidence: high
tags: [sma, memory, cold-tier, episodes]
sources:
  - src/rooms/memory/server/services/memory.ts
  - src/rooms/memory-tiers/server/services/tiers.ts
  - src/rooms/memory-tiers/models/tiers.ts
  - src/rooms/tools/server/handlers/cli-commands.ts
---

# Memory tiers (SMA D2-8)

TL;DR: The PM context query can restore matching idle notes, add matching past tasks, and record empty results as memory misses.

## Purpose

Add a cold-note tier, task episodes, and miss records around the PM's `lane_pilot_memory {action:"context"}` query. Cold notes stay stored after idle expiry and can be restored to active search when a context query has fewer than three active matches (`src/rooms/memory-tiers/server/services/tiers.ts`).

## How it works

1. The context handler verifies the active PM thread and run, loads memory settings, and returns `skipped` when memory is disabled. It selects the normal active memory context before invoking tier enrichment (`src/rooms/memory/server/services/memory.ts`).
2. When fewer than three active records were selected, `coldMatches` reads expired notes without `valid_until` or a replacement id and formats them for the PM context without changing their status (`src/rooms/memory-tiers/server/services/tiers.ts`, `src/rooms/memory-tiers/models/tiers.ts`).
3. `episodes` checks up to the 400 newest project tasks and returns up to three matches with latest attempt state.
4. If there are no active records, cold matches, or matching episodes, the query inserts a row into `lane_pilot_memory_miss`.

| Mode or state | Inputs and result | Failure behavior |
|---|---|---|
| Memory disabled | Context query returns `state: "skipped"` with `memory_disabled` before active or tier lookup (`src/rooms/memory/server/services/memory.ts`). | No tier work is attempted. |
| At least three active records | Cold-note lookup is skipped; episode matching still runs. | Tier database errors are caught by the context handler and logged; the active context still returns. |
| Fewer than three active records | Cold notes are matched and up to three promoted; episodes are matched independently. | Malformed task contract JSON excludes that task from episode results. |
| No matching records or episodes | Miss is inserted only when active, promoted, and episode counts are all zero. | Empty or too-short query words match nothing. |
| CLI argument error | `memory-tiers` accepts no arguments or `--project P` (`src/rooms/tools/server/handlers/cli-commands.ts`). | Other argument shapes return exit code 1 and usage text. |

## Business rules

- Query matching uses up to twelve unique lowercase words of at least four characters, excluding built-in stop words (`src/rooms/memory-tiers/models/tiers.ts`).
- Only idle-expired `note` records with no validity date and no `superseded_by` value belong to the cold tier (`src/rooms/memory-tiers/server/services/tiers.ts`).
- The report's needed-again share is `promoted / (cold + promoted)`, rounded to three decimal places (`src/rooms/memory-tiers/server/services/tiers.ts`).

## Public API or commands

`bb lane-pilot memory-tiers [--project P]` prints cold-note count, distinct promoted-note count, needed-again share, and recent misses (`src/rooms/tools/server/handlers/cli-commands.ts`).

## Gotchas

Tier enrichment is best-effort: an exception logs `memory tiers skipped` and the context response returns regular active memory (`src/rooms/memory/server/services/memory.ts`). Promoted notes become active records and regain their search indexes (`src/rooms/memory-tiers/server/services/tiers.ts`).
