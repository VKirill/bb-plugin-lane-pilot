---
title: Memory core workspace overview
type: overview
created: 2026-11-07
updated: 2026-11-07
status: active
confidence: high
tags: [memory, knowledge, workspace, sqlite]
sources:
  - packages/memory-core/package.json
  - packages/memory-core/src/index.ts
  - packages/memory-core/src/settings.ts
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/candidates.ts
  - packages/memory-core/src/context.ts
  - packages/memory-core/src/context-pack.ts
  - packages/memory-core/src/floor.ts
  - packages/memory-core/src/vectors.ts
  - packages/memory-core/src/conflicts.ts
  - packages/memory-core/src/conflict-store.ts
  - packages/memory-core/src/lifecycle.ts
  - packages/memory-core/src/files.ts
  - packages/memory-core/src/fingerprint.ts
  - packages/memory-core/src/sections.ts
  - packages/memory-core/src/terms.ts
  - src/rooms/storage/database.ts
  - src/rooms/memory/server/session-memory.ts
  - src/rooms/memory/server/memory.ts
  - src/rooms/writer/server/writer-knowledge.ts
  - packages/run-insights/src/lessons.ts
  - src/rooms/writer/server/spawn.ts
  - src/rooms/memory-eval/server/retrievers.ts
  - src/rooms/council/server/council.ts
  - src/rooms/learning/rules-port.ts
---

# Memory core workspace overview

TL;DR: `@lane-pilot/memory-core` provides guarded project memory storage, admission validation, token budget enforcement, hybrid search, relevance filtering, and context packing over SQLite.

## Purpose

The workspace encapsulates project memory logic for agent sessions (`packages/memory-core/package.json:3-5`). It provides:
- Parsing and admission screening of model candidates, rejecting credentials and instruction overrides (`packages/memory-core/src/candidates.ts:15-18`).
- Transactional record storage with automated budget eviction and core overflow demotion (`packages/memory-core/src/store.ts:121-207`, `packages/memory-core/src/store.ts:262-274`).
- Hybrid search fusing word indexing, trigram substring matching, and 768-dimensional vector cosine similarity (`searchMemoryRecords` in `packages/memory-core/src/store.ts:323-359`, `EMBED_DIM` in `packages/memory-core/src/vectors.ts:13-14`).
- Relevance filtering using word frequency log-scaling and dense vector cutoffs (`packages/memory-core/src/floor.ts:31-35`, `packages/memory-core/src/floor.ts:96-120`).
- Context assembly for prompts and session packets under strict role budgets (`packages/memory-core/src/context.ts:48-64`, `packages/memory-core/src/context-pack.ts:26-67`).
- Pairwise conflict detection and hold mechanisms (`packages/memory-core/src/conflicts.ts:95-105`, `packages/memory-core/src/conflict-store.ts:62-76`).
- File synchronization with repository `.agents/memory/*.md` markdown files (`packages/memory-core/src/files.ts:46-107`, `packages/memory-core/src/files.ts:119-152`).

## How it is used

1. The hosting plugin or harness initializes an SQLite database instance implementing `MemoryDatabase` (`packages/memory-core/src/store.ts:11-13`). Table creation scripts for vectors (`vectorsReady` in `packages/memory-core/src/vectors.ts:19-31`) and conflicts (`memoryConflictMigrations` in `packages/memory-core/src/conflict-store.ts:16-36`) run lazily or via migrations.
2. Raw project settings are validated into a typed `MemorySettings` object (`packages/memory-core/src/settings.ts:56-64`).
3. An agent or maintainer model emits candidate entries, parsed and validated by `parseMemoryCandidates` against token budgets and admission rules (`packages/memory-core/src/candidates.ts:78-115`).
4. Validated candidates are written to SQLite via `storeMemoryRecordsKeepingOverflow` or `storeMemoryRecords`, which updates search indexes and handles budget evictions (`packages/memory-core/src/store.ts:121-240`, `packages/memory-core/src/store.ts:262-274`).
5. Working sessions search memory using `searchMemoryRecords` or `searchMemoryAllSections`, passing an optional section chain to enforce isolation (`packages/memory-core/src/store.ts:319-353`).
6. Retrieved candidate records pass through `relevantRecords` to filter out records failing the relevance floor (`packages/memory-core/src/floor.ts:112-120`).
7. Selected records are packaged into prompt text via `memoryContext` or built into an immutable session context pack via `buildContextPack` (`packages/memory-core/src/context.ts:55-64`, `packages/memory-core/src/context-pack.ts:26-67`).
8. Accepted task attempts report feedback via `recordMemoryAccepted` (`packages/memory-core/src/lifecycle.ts:114-117`) to adjust `memoryUsefulness` scores (`packages/memory-core/src/lifecycle.ts:87-91`).

## Public entry points

The package root `packages/memory-core/src/index.ts:1-30` exports all core types, schemas, and utility functions.

The workspace does not expose network routes or bot commands directly; it operates as an internal library consumed by parent rooms and packages.

Primary exported functions include:
- `parseMemorySettings`: parses and validates project settings (`packages/memory-core/src/settings.ts:56-64`).
- `parseMemoryCandidates`: parses and validates candidate objects from model output (`packages/memory-core/src/candidates.ts:78-115`).
- `storeMemoryRecords`: inserts records, evicts low-utility notes on budget overflow, and indexes entries (`packages/memory-core/src/store.ts:121-240`).
- `storeMemoryRecordsKeepingOverflow`: writes records, automatically demoting overflowing core entries to notes (`packages/memory-core/src/store.ts:262-274`).
- `searchMemoryRecords`: hybrid search combining FTS5 BM25, trigrams, and vector cosine ranking (`packages/memory-core/src/store.ts:323-353`).
- `relevantRecords`: applies relevance thresholds based on query length and path anchors (`packages/memory-core/src/floor.ts:112-120`).
- `buildContextPack`: builds deterministic session context packets adhering to role caps (`packages/memory-core/src/context-pack.ts:26-67`).
- `findConflicts`: detects pairwise disagreements between notes (`packages/memory-core/src/conflicts.ts:95-105`).

## Configuration

Configuration values defined in `MEMORY_SETTING_KEYS` (`packages/memory-core/src/settings.ts:38-39`) are parsed by `parseMemorySettings` (`packages/memory-core/src/settings.ts:56-64`):

| Setting key | Type | Default | Valid values / Limits | Evidence |
|---|---|---|---|---|
| `memory.enabled` | boolean | `true` | `true`, `false` | `packages/memory-core/src/settings.ts:63` |
| `memory.maintain` | boolean | `true` | `true`, `false` | `packages/memory-core/src/settings.ts:63` |
| `memory.inject` | boolean | `true` | `true`, `false` | `packages/memory-core/src/settings.ts:63` |
| `memory.audience` | string | `"subagent"` | `"owner"`, `"subagent"`, `"export"` | `MEMORY_AUDIENCES` in `packages/memory-core/src/settings.ts:1`; `packages/memory-core/src/settings.ts:60` |
| `memory.personal_bot` | string | `""` | `""`, `"claude"`, `"codex"`, `"grok"`, `"qwen"`, `"kimi"`, `"agy"`, `"cursor"` | `MEMORY_PERSONAL_BOTS` in `packages/memory-core/src/settings.ts:3`; `packages/memory-core/src/settings.ts:61` |
| `memory.search_engine` | string | `"auto"` | `"auto"`, `"fts5"`, `"bm25"` | `MEMORY_SEARCH_ENGINES` in `packages/memory-core/src/settings.ts:2`; `packages/memory-core/src/settings.ts:62` |
| `memory.core_budget` | integer | `3072` | `1` to `1000000` tokens | `MAX_BUDGET` in `packages/memory-core/src/settings.ts:36`; `packages/memory-core/src/settings.ts:63` |
| `memory.note_budget` | integer | `24000` | `1` to `1000000` tokens | `MAX_BUDGET` in `packages/memory-core/src/settings.ts:36`; `packages/memory-core/src/settings.ts:63` |
| `memory.index_budget` | integer | `65536` | `1` to `1000000` tokens | `MAX_BUDGET` in `packages/memory-core/src/settings.ts:36`; `packages/memory-core/src/settings.ts:63` |
| `memory.context_budget` | integer | `2500` | `1` to `1000000` tokens | `MAX_BUDGET` in `packages/memory-core/src/settings.ts:36`; `packages/memory-core/src/settings.ts:63` |
| `memory.maintain_every` | integer | `3` | `>= 1` tasks | `packages/memory-core/src/settings.ts:63` |
| `memory.salience_min` | integer | `40` | `0` to `100` | `packages/memory-core/src/settings.ts:63` |
| `memory.pack_mode` | string | `"shadow"` | `"off"`, `"shadow"`, `"adapter"`, `"canary"` | `packages/memory-core/src/settings.ts:63` |
| `memory.query_floor` | boolean | `true` | `true` (unless `"off"`) | `packages/memory-core/src/settings.ts:63` |
| `memory.project_kind` | string | `"auto"` | `"auto"`, `"standalone"`, `"umbrella"` | `packages/memory-core/src/settings.ts:63` |

## Consumers

The package is consumed across the workspace and plugin rooms:
- `@lane-pilot/run-insights`: imports `MemoryCandidate` for lesson generation (`packages/run-insights/src/lessons.ts:1`).
- `src/rooms/storage/database.ts`: re-exports `searchMemoryRecords` and `storeMemoryRecords`, calls `noteRefutedByCheck` and `recordMemoryAccepted` (`src/rooms/storage/database.ts:11-14`).
- `src/rooms/memory/server/session-memory.ts`: handles hub RPC methods for searching, reading core, and storing memory (`src/rooms/memory/server/session-memory.ts:6-10`).
- `src/rooms/memory/server/memory.ts`: memory maintenance room managing overflows, curators, and migrations (`src/rooms/memory/server/memory.ts:10-17`).
- `src/rooms/writer/server/writer-knowledge.ts`: constructs writer context packets using `buildContextPack` and relevance checks (`src/rooms/writer/server/writer-knowledge.ts:3-5`).
- `src/rooms/writer/server/spawn.ts`: records memory receipts and mixed notes for task attempts (`src/rooms/writer/server/spawn.ts:3`).
- `src/rooms/memory-eval/server/retrievers.ts`: benchmark evaluation harness assessing retrieval performance (`src/rooms/memory-eval/server/retrievers.ts:2`).
- `src/rooms/council/server/council.ts`: retrieves memory context for council deliberations (`src/rooms/council/server/council.ts:2`).
- `src/rooms/learning/rules-port.ts`: stores rules as memory records (`src/rooms/learning/rules-port.ts:1`).

## Related pages

- [Memory admission and storage](features/admission-and-storage.md)
- [Memory search and retrieval](features/search-and-retrieval.md)
- [Memory relevance floor](features/relevance-floor.md)
- [Memory context packing](features/context-packing.md)
- [Memory conflict management](features/conflict-management.md)
- [Memory lifecycle and file integration](features/lifecycle-and-files.md)
- [Memory core data model](data-model.md)
- [Memory core gotchas](gotchas.md)
