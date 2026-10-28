---
title: Memory tiers (SMA D2-8)
type: component
created: 2026-10-23
updated: 2026-10-28
status: active
confidence: high
tags: [sma, memory, cold-tier, episodes]
sources:
  - src/rooms/memory/server/memory.ts
  - src/rooms/memory-tiers/server/tiers.ts
  - src/rooms/memory-tiers/logic.ts
  - src/rooms/tools/server/cli.ts
---

# Memory tiers (SMA D2-8)

TL;DR: The PM context query can restore matching idle notes, add matching past tasks, and record empty results as memory misses.

## Purpose

Add a cold-note tier, task episodes, and miss records around the PM's `lane_pilot_memory {action:"context"}` query. Cold notes stay stored after idle expiry and can be restored to active search when a context query has fewer than three active matches (`src/rooms/memory-tiers/server/tiers.ts:5-10`, `:52-64`).

## How it works

1. The context handler verifies the active PM thread and run, loads memory settings, and returns `skipped` when memory is disabled. It selects the normal active memory context before invoking the tier enrichment (`src/rooms/memory/server/memory.ts:211-225`).
2. When fewer than three active records were selected, `coldMatches` reads expired notes without `valid_until` or a replacement id. It tokenizes the query, counts matching words in each note's content and concepts, keeps notes meeting the minimum hit count, sorts by hits then id, and returns at most three (`src/rooms/memory-tiers/server/tiers.ts:13-21`, `src/rooms/memory-tiers/logic.ts:7-19`).
3. `promote` changes each still-eligible match to `active`, sets `last_used_at`, restores its search indexes, and inserts a promotion record. The context adds the promoted note text and ids to its result (`src/rooms/memory-tiers/server/tiers.ts:23-33`, `:55-64`, `src/rooms/memory/server/memory.ts:224-228`).
4. `episodes` checks up to the 400 newest project tasks, parses each task contract, and compares the query words with its display title/title and objective. It returns up to three matches that have a latest attempt state, ordered by hits and task time; each line includes task id, title, date, state, and optional reason (`src/rooms/memory-tiers/server/tiers.ts:36-50`, `src/rooms/memory-tiers/logic.ts:21-26`).
5. If there are no selected active records, no promoted cold notes, and no matching episodes, the query inserts a row into `lane_pilot_memory_miss`. The response combines the active and tier context, and includes promotion and episode counts when nonzero (`src/rooms/memory-tiers/server/tiers.ts:52-64`, `src/rooms/memory/server/memory.ts:222-228`).

| Mode or state | Inputs and result | Failure behavior |
|---|---|---|
| Memory disabled | Context query returns `state: "skipped"` with `memory_disabled` before active or tier lookup (`src/rooms/memory/server/memory.ts:216-222`). | No tier work is attempted. |
| At least three active records | Cold-note lookup is skipped; episode matching still runs (`src/rooms/memory-tiers/server/tiers.ts:52-57`). | Tier database errors are caught by the context handler and logged; the active context still returns (`src/rooms/memory/server/memory.ts:223-228`). |
| Fewer than three active records | Cold notes are matched and up to three promoted; episodes are matched independently (`src/rooms/memory-tiers/server/tiers.ts:15-21`, `:36-49`, `:55-57`). | Malformed task contract JSON excludes that task from episode results (`src/rooms/memory-tiers/server/tiers.ts:43-46`). |
| No matching records or episodes | The miss is inserted only when active count is zero and no cold note was promoted or episode matched (`src/rooms/memory-tiers/server/tiers.ts:57-59`). | Empty or too-short query words match no cold notes or episodes (`src/rooms/memory-tiers/logic.ts:7-19`, `src/rooms/memory-tiers/server/tiers.ts:15-17`, `:36-39`). |
| CLI argument error | `memory-tiers` accepts no arguments or exactly `--project P` (`src/rooms/tools/server/cli.ts:331-333`). | Other argument shapes return exit code 1 and usage text. |

## Business rules

- Query matching uses up to twelve unique lowercase words of at least four characters, excluding the built-in stop words. A match needs two shared words, or one when the query has only one word (`src/rooms/memory-tiers/logic.ts:5-19`).
- Only idle-expired `note` records with no validity date and no `superseded_by` value belong to the cold tier (`src/rooms/memory-tiers/server/tiers.ts:13-20`).
- The report's needed-again share is `promoted / (cold + promoted)`, rounded to three decimal places. It reports misses from the last 30 days, newest first, with a maximum of 50 (`src/rooms/memory-tiers/server/tiers.ts:67-74`).

## Public API or commands

`bb lane-pilot memory-tiers [--project P]` prints JSON containing cold-note count, distinct promoted-note count, needed-again share, and recent misses (`src/rooms/tools/server/cli.ts:331-334`, `src/rooms/memory-tiers/server/tiers.ts:67-74`). The PM context action uses `runMemoryContext`, which invokes `enrichMemoryContext` after selecting active records (`src/rooms/memory/server/memory.ts:211-228`).

## Gotchas

Tier enrichment is best-effort: an exception logs `memory tiers skipped` and the context response still contains the regular active-memory result (`src/rooms/memory/server/memory.ts:223-228`). Promoted notes become active records and regain their search indexes; promotion is not a separate read-only view (`src/rooms/memory-tiers/server/tiers.ts:23-33`).
