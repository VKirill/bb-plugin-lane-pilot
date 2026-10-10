---
title: Anamnesis and owner profile
type: component
created: 2026-10-10
updated: 2026-10-10
status: active
confidence: medium
tags: [anamnesis, privacy, owner-profile]
sources:
  - src/rooms/anamnesis/collect.ts
  - src/rooms/anamnesis/pii.ts
  - src/rooms/anamnesis/year-review.ts
  - src/rooms/anamnesis/store.ts
  - src/rooms/anamnesis/index.ts
  - src/rooms/core/server/core.ts
---

# Anamnesis and owner profile

TL;DR: Anamnesis gathers owner-approved source records, stores them with evidence and sensitivity, masks detected personal data, and renders profile summaries.

## Purpose

Build an evidence-backed profile from enabled local sources and expose records to the owner through the Anamnesis room (`src/rooms/anamnesis/collect.ts:29-44`, `src/rooms/anamnesis/store.ts:53-71`).

## How it works

1. `collectSources` fills default roots and authors, then maps each requested source to a scanner (`src/rooms/anamnesis/collect.ts:29-44`).
2. Disabled sources return a `switched off` result without scanning. Scanner errors are captured per source and do not stop the remaining source loop (`src/rooms/anamnesis/collect.ts:45-53`).
3. Run mode upserts records and advances the source checkpoint in one transaction; preview mode calls the store's dry-run path (`src/rooms/anamnesis/collect.ts:54-60`).
4. Record counts are grouped by kind and by a sensitivity floor; the collector reports only private and sensitive classifications (`src/rooms/anamnesis/collect.ts:65-74`).
5. `maskPii` redacts email, valid IBAN and card values, account and identity numbers, phone numbers, and address patterns while returning detected kinds and count (`src/rooms/anamnesis/pii.ts:41-72`).
6. `renderYearReview` chooses the requested year or the UTC year from its clock, filters sensitive records through the visibility helper, then summarizes skills, projects, commits, events and empty years (`src/rooms/anamnesis/year-review.ts:13-19`, `:21-72`).

## Modes and branches

| Mode or source branch | Inputs and effect | Failure behavior |
|---|---|---|
| `preview` | Scans enabled sources and applies updates through `dryRun`; no checkpoint write (`src/rooms/anamnesis/collect.ts:54-57`). | Scanner errors are returned for that source. |
| `run` | Upserts records and stores a checkpoint in one transaction (`src/rooms/anamnesis/collect.ts:54-57`). | Scanner errors become an error result; later sources continue. |
| Disabled source | Records `switched off`, zero counts and does not invoke its scanner (`src/rooms/anamnesis/collect.ts:45-48`). | None. |
| Sensitive record in annual review | Excluded by `visibleRecords`; the result reports hidden count when not `publicOnly` (`src/rooms/anamnesis/year-review.ts:17-19`, `:70-72`). | No sensitive record body is added to the review. |

## Business rules

Source scanning is enabled per source in the store, and only run mode advances checkpoints (`src/rooms/anamnesis/collect.ts:45-57`). An annual review only counts records with evidence and reports year-bounded project activity and milestones (`src/rooms/anamnesis/year-review.ts:13-19`, `:38-67`).

## Public API or commands

`collectSources(request, store, seams?)` is the collection entry point; seams can inject home path and source scanners (`src/rooms/anamnesis/collect.ts:27-35`). `maskPii(input)` returns `{text, count, kinds}` (`src/rooms/anamnesis/pii.ts:41-43`, `:72`). `renderYearReview(records, options)` returns review text and visibility counts (`src/rooms/anamnesis/year-review.ts:13-19`, `:70-72`).

## Gotchas

The code calls its inputs records with evidence, but masking is pattern-based: invalid IBAN/card/INN candidates are retained by their validators (`src/rooms/anamnesis/pii.ts:54-64`). The storage schema and its retention behavior are described by the [data model overview](data-model.md).
