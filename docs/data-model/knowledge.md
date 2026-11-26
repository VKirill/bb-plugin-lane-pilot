---
title: Project memory data
type: data-model
created: 2026-10-10
updated: 2026-11-26
status: active
confidence: medium
tags: [data-model, memory]
sources:
  - src/rooms/storage/database.ts
  - packages/memory-core/src/store.ts
  - packages/memory-core/src/lifecycle.ts
  - packages/memory-core/src/candidates.ts
  - src/rooms/legacy-migrations.ts
---

# Project memory data

TL;DR: Project memory stores scoped core notes, facts and full-text search indexes in plugin SQLite (`packages/memory-core/src/store.ts`).

## Project memory

Maintainer candidate parsing is an input boundary, not a separate stored entity: supported fields become memory records, recognized boolean review labels become concepts, empty extras are ignored, and other non-empty unknown fields reject the candidate batch (`packages/memory-core/src/candidates.ts:37-64`).

| Table | Meaning | Lifecycle and invariants | Writers and readers |
|---|---|---|---|
| `lane_pilot_memory` | `id` stable record key; `project_id` and `personal_bot` scope; `kind` (`core`/`note`); `audience` (`owner`/`subagent`/`export`); `content`; `concepts_json`; source SHA-256; creation time; `status`; replacement id; optional validity deadline; last-used time; use and accepted counts; `trust` (`confirmed`/`observed`); `origin`; optional source file id. | Status values are `active`, `superseded`, and `expired`. Active records become superseded when replaced or expired by validity/idle/budget; an expired matching record can be revived when restated (`packages/memory-core/src/store.ts:103-109`, `:113-126`, `:157-161`; `packages/memory-core/src/lifecycle.ts:16-20`). | Session, maintainer, and file import writers store records; retrieval, maintenance, and accepted-attempt accounting read/update them (`packages/memory-core/src/store.ts:83-93`, `:147-168`; `packages/memory-core/src/lifecycle.ts:71-80`). |
| `lane_pilot_memory_fts` | `id` and `project_id` scope FTS rows; `content` and `concepts` are indexed text. | FTS5 index is updated with record inserts and removals; trigram search index is created on first use when the SQLite tokenizer exists (`packages/memory-core/src/store.ts:36-66`). | Memory store maintains the index; project memory search reads it and falls back to a code scan when trigram support is unavailable (`packages/memory-core/src/store.ts:36-55`, `:58-66`). |

| Status or trust transition | Function and condition |
|---|---|
| `active` → `superseded` | `storeMemoryRecords` replaces a same-file or explicitly superseded record, or an older same-subject note (`packages/memory-core/src/store.ts:113-126`). |
| `active` → `expired` | `expireMemory` hides expired validity and idle notes; note-budget eviction uses the same status (`packages/memory-core/src/lifecycle.ts:16-20`, `packages/memory-core/src/store.ts:134-145`). |
| `expired` → `active` | A matching record is revived when its fact is stated again or its source file provides it again (`packages/memory-core/src/store.ts:103-109`, `:157-161`). |
| `observed` → `confirmed` | A second independent source corroborates the same observed record (`packages/memory-core/src/store.ts:103-105`, `:163`). |

## Retention

Project memory notes not used for 90 days expire; observed records wait 24 hours for a second source before writer use (`packages/memory-core/src/lifecycle.ts:4-7`). The older `anamnesis` and `learning` rooms were removed; their positional historical table DDLs stay only in `src/rooms/legacy-migrations.ts` to preserve SQLite migration indices.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Lane Pilot data model overview](../data-model.md)
