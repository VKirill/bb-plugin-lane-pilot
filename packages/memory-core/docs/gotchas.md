---
title: Memory core gotchas
type: gotchas
created: 2026-11-07
updated: 2026-11-07
status: active
confidence: medium
tags: [memory, gotchas, pitfalls, sqlite, budgets, concurrency]
sources:
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/candidates.ts
  - packages/memory-core/src/vectors.ts
  - packages/memory-core/src/floor.ts
  - packages/memory-core/src/conflict-store.ts
  - packages/memory-core/src/context-pack.ts
  - packages/memory-core/src/context.ts
  - packages/memory-core/src/lifecycle.ts
  - packages/memory-core/src/sections.ts
  - packages/memory-core/src/files.ts
  - packages/memory-core/src/fingerprint.ts
---

# Memory core gotchas

TL;DR: Pitfalls in memory core include raw store core budget throws, lazy trigram table creation, query vector cache separation, silent conflict suppression, and umbrella scope hiding.

## Raw `storeMemoryRecords` throws on core budget overflow

When calling `storeMemoryRecords` directly, if the combined token count of new and existing active core records exceeds `coreBudget`, the function throws `memory core budget exceeded: <core>/<budget> tokens` (`packages/memory-core/src/store.ts:194`).

Because core records are never evicted, this throws out the entire database transaction and discards all candidate notes in the same batch. Maintainer ingestion calls `storeMemoryRecordsKeepingOverflow`, which demotes excess core records to note kind until the batch fits (`packages/memory-core/src/store.ts:262-274`).

## Trigram virtual tables rely on lazy initialization

The trigram search index `lane_pilot_memory_trgm` is not created by database migrations; `trigramReady` attempts to create it upon first use inside a `WeakMap` cache (`packages/memory-core/src/store.ts:60-75`).

If the host SQLite installation lacks the FTS5 trigram tokenizer (SQLite versions prior to 3.34), the table creation throws internally, `trigramReady` (`packages/memory-core/src/store.ts:60-75`) marks the database as unsupported, and search falls back to in-memory substring scanning via `scanRows` (`packages/memory-core/src/store.ts:340`, `packages/memory-core/src/store.ts:388-392`). In large databases, this fallback loads every active row into JavaScript memory on each search.

## Vector search requires pre-synchronization of query vectors

Search execution is synchronous, but model embedding calls are asynchronous (`packages/memory-core/src/vectors.ts:99-103`).

Callers must await external vector generation and invoke `rememberQueryVector` (`packages/memory-core/src/vectors.ts:105-109`) before invoking `searchMemoryRecords` (`packages/memory-core/src/store.ts:323-326`), which calls `denseRows` (`packages/memory-core/src/store.ts:360-363`). If `rememberQueryVector` is not called, search silently skips vector cosine ranking and returns fused lexical/trigram results without throwing an error.

Additionally, `rememberQueryVector` stores vectors in a process-local `Map` capped at 256 entries (`packages/memory-core/src/vectors.ts:104-109`). Query vectors do not persist across process restarts or worker boundaries.

## Held conflicts silently suppress notes from all readers

When two active notes contradict each other and are registered in `lane_pilot_memory_conflict` with `state = 'held'`, `heldClause` appends a SQL `NOT EXISTS` condition to all search queries (`packages/memory-core/src/conflict-store.ts:62-65`, `packages/memory-core/src/store.ts:309`).

Neither note is returned to searchers, PM tools, or context packers, and no warning is surfaced indicating that information was suppressed. The facts become invisible until a human operator settles the conflict (`packages/memory-core/src/conflict-store.ts:7-13`, `packages/memory-core/src/conflict-store.ts:94-96`).

## Hedged statements are demoted to observed quarantine

Any maintainer note containing hedging words ("maybe", "perhaps", "might", "seems", "appears", "possibly", "кажется", "возможно", "похоже") is automatically demoted to `trust = 'observed'`, even if the write request specified `trust = 'confirmed'` (`packages/memory-core/src/store.ts:114-119`, `packages/memory-core/src/store.ts:125`).

As an observed note, it is quarantined and hidden from working readers for 24 hours (`OBSERVED_QUARANTINE_MS = 24 * 3_600_000`) unless corroborated by an independent second source (`packages/memory-core/src/lifecycle.ts:5`, `packages/memory-core/src/store.ts:309`).

## Required candidates in context packs throw when oversized

In `buildContextPack` (`packages/memory-core/src/context-pack.ts:26-31`), candidates marked with `required` in `PackCandidate` (`packages/memory-core/src/context-pack.ts:8-10`, `packages/memory-core/src/context-pack.ts:45-53`) are never truncated or omitted.

If the combined size of required candidates exceeds the role budget (`roleContextBudget`), `buildContextPack` throws `context_pack_oversized:<kind>:<id>` naming the largest candidate (`packages/memory-core/src/context-pack.ts:47-50`). Senders must ensure required policies fit inside role ceilings (e.g., PM: 1,600 tokens; Helper: 600 tokens) (`packages/memory-core/src/context.ts:48-53`).

## Unassigned scopes in umbrella projects are inaccessible

In an umbrella project where `resolveProjectKind` (`packages/memory-core/src/sections.ts:6-12`) or `projectUsesSections` (`packages/memory-core/src/store.ts:299-302`) resolves an umbrella, records written without a section scope are assigned to `UNASSIGNED_SCOPE` (`packages/memory-core/src/sections.ts:19-20`).

Standard working reader searches filter visibility by prefix matching the reader's section chain (`packages/memory-core/src/store.ts:292-296`, `packages/memory-core/src/store.ts:310`). Notes in the unassigned scope will not match any normal reader chain and remain inaccessible until explicitly rebound to a section.

## Omitting section chain defaults to project root only

When invoking `searchMemoryRecords` or `listMemory`, omitting `options.chain` defaults the reader's scope to `[]` (the project root) (`packages/memory-core/src/store.ts:285-288`, `packages/memory-core/src/store.ts:310`).

The reader will see only root-level and project-wide records, completely excluding notes belonging to child sections or subcomponents. Working sessions must explicitly supply their section chain.

## Updating record status directly corrupts search indexes

Setting `status = 'superseded'` or `status = 'expired'` via raw SQL without calling `dropMemoryIndexes` (`packages/memory-core/src/store.ts:78-81`) leaves dead records inside `lane_pilot_memory_fts` and `lane_pilot_memory_trgm`; `hideRecord` (`packages/memory-core/src/lifecycle.ts:30-34`) requires an `unindex` callback to purge them.

Conversely, updating an expired record to `'active'` without invoking `addToIndexes` leaves the revived record invisible to full-text and trigram queries (`packages/memory-core/src/store.ts:84-87, 216, 222`). Always use `hideRecord` or `storeMemoryRecords` to mutate statuses.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Memory core workspace overview](overview.md)
