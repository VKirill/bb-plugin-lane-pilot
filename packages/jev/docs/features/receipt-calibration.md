---
title: Jev receipts, calibration and monitoring
type: component
created: 2026-11-05
updated: 2026-11-05
status: active
confidence: medium
tags: [jev, receipts, calibration, monitoring]
sources:
  - packages/jev/src/receipts.ts
  - packages/jev/src/calibrate.ts
  - packages/jev/src/autoresearch.ts
  - packages/jev/src/watch.ts
  - packages/jev/src/labels-outcome.ts
  - packages/jev/src/labels-model.ts
  - packages/jev/src/run.ts
  - src/rooms/storage/database.ts
  - src/rooms/jev/cli.ts
  - packages/jev/src/index.ts
---

# Jev receipts, calibration and monitoring

TL;DR: Receipts capture each uncached judgment call without storing its state text; later labels support threshold reports and per-judgment monitoring.

## Purpose

A receipt records judgment/version/model, mode, project/run/subject, a state hash and size, question count, answers, decision, status, thresholds, latency, tokens and later outcome labels (`packages/jev/src/receipts.ts:9-40`, `packages/jev/src/receipts.ts:42-53`).

The `createJev` runner writes only when a DB exists, mode is not off and the provider call was not a cache hit (`packages/jev/src/run.ts:79-119`).

## How it works

1. On a non-cached judgment call, `createJev` inserts a receipt with the redacted state's hash and size, answer summary, field sizes and current thresholds (`packages/jev/src/run.ts:79-122`).
2. One in five deterministic input-hash samples retains redacted input JSON, capped at 8 KiB; the state itself is not written as plain text (`packages/jev/src/receipts.ts:58-70`).
3. Escalated or later outcome workflows attach a label using `recordOutcome`; outcome and timestamp are stored on the row (`packages/jev/src/receipts.ts:86-88`).
4. Calibration calculates candidate threshold performance from labeled receipts and stores proposals with judgment fingerprint and model binding (`packages/jev/src/calibrate.ts:48-76`, `packages/jev/src/calibrate.ts:89-147`).
5. Watch compares judgment/project slices against a baseline and returns accuracy, error, escalation and latency findings (`packages/jev/src/watch.ts:35-45`, `packages/jev/src/watch.ts:79-116`).

## Modes and report branches

| Operation | Input and branch | Output | Evidence |
|---|---|---|---|
| Receipt insert | Judgment call with DB, not off and not cached | Row ID; insert failure is logged by runner and yields null | `packages/jev/src/run.ts:109-127` |
| Outcome label | Receipt ID and label text | Sets `outcome` and `outcome_at` | `packages/jev/src/receipts.ts:86-88` |
| Threshold calibration | Receipts since timestamp; minimum 10 labels by default | Gate, sort-only or dead classification and suggested thresholds | `packages/jev/src/calibrate.ts:16-17`, `packages/jev/src/calibrate.ts:42-47`, `packages/jev/src/calibrate.ts:89-147` |
| Autoresearch | At least 30 labeled receipts by default | Grid-search threshold proposals | `packages/jev/src/autoresearch.ts:10-12`, `packages/jev/src/autoresearch.ts:37-62` |
| Watch | Explicit window and baseline days | Per judgment/project slices and drift findings | `packages/jev/src/watch.ts:17-45`, `packages/jev/src/watch.ts:79-116` |
| Pruning | Runs on every 100th generated receipt ID | Deletes older than 30 days and rows beyond 50,000 | `packages/jev/src/receipts.ts:55-56`, `packages/jev/src/receipts.ts:72-83`, `packages/jev/src/receipts.ts:90-93` |

## Failure behavior

- Failed calls are recorded with a status when the call was made in shadow or active mode; off mode has no receipt (`packages/jev/src/run.ts:109-127`, `packages/jev/src/receipts.ts:9-40`).
- A missing or unparseable sampled input is skipped by the model label planner; image/box judgments cannot be re-rendered from text and are excluded (`packages/jev/src/labels-model.ts:4-12`, `packages/jev/src/labels-model.ts:27-38`).
- A decision cannot be calibrated from an unlabeled receipt; reports use labeled outcomes and record no proposal when their minimum sample gate is unmet (`packages/jev/src/calibrate.ts:89-143`, `packages/jev/src/autoresearch.ts:37-62`).

## Business rules

- Receipt retention is bounded by both 30 days and 50,000 rows; pruning is triggered roughly once per 100 inserted row IDs (`packages/jev/src/receipts.ts:55-56`, `packages/jev/src/receipts.ts:72-93`).
- Sampled input is selected deterministically from the input hash and may be truncated with a marker that makes its JSON unparsable (`packages/jev/src/receipts.ts:58-70`).
- Calibrated thresholds apply only when the fingerprint and model match; changed judgment semantics or model version invalidate the stored calibration (`packages/jev/src/calibrate.ts:48-76`).

## Public API or commands

`insertReceipt` implements receipt insertion (`packages/jev/src/receipts.ts:72-83`).

`recordOutcome` writes outcome labels (`packages/jev/src/receipts.ts:86-88`).

`pruneReceipts` removes expired or excess rows (`packages/jev/src/receipts.ts:90-93`).

`summarizeReceipts` groups receipt results (`packages/jev/src/receipts.ts:95-100`).

`calibrateReceipts` and `calibrationRecord` build threshold reports (`packages/jev/src/calibrate.ts:89-159`).

`autoresearchThresholds` builds grid-search proposals (`packages/jev/src/autoresearch.ts:37-62`).

`jevWatch` builds monitoring reports (`packages/jev/src/watch.ts:79-137`).

Parent-plugin commands such as `bb lane-pilot jev calibrate` and `jev watch` are implemented outside this workspace (`src/rooms/jev/cli.ts:10-20`).

## Gotchas

- The receipt table's initial DDL is followed by plugin migrations adding `fields_json` (`src/rooms/storage/database.ts:444-445`) and `input_json` (`src/rooms/storage/database.ts:480-481`).
- Use the assembled migrations, not the initial statement alone (`packages/jev/src/receipts.ts:9-40`).
- Outcome labelers query only eligible receipts with `outcome IS NULL`, so already labeled rows do not enter their normal relabel flow (`packages/jev/src/labels-outcome.ts:22-31`).
- The CLI's `--save` writes certified thresholds into project settings; autoresearch itself returns proposals (`src/rooms/jev/cli.ts:10-20`, `packages/jev/src/autoresearch.ts:37-62`).

## Related pages

- [Data model](../data-model.md)
- [Typed judgments](typed-judgments.md)
- [Client and runtime](client-runtime.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Judgment receipts](../data-model/receipts.md)
- [Jev client and runtime](client-runtime.md)
- [Typed judgments](typed-judgments.md)
- [Jev gotchas](../gotchas.md)
- [Jev workspace overview](../overview.md)
