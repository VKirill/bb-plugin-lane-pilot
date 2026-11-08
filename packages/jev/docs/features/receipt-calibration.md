---
title: Jev receipts, calibration and monitoring
type: component
created: 2026-11-05
updated: 2026-11-08
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
  - src/rooms/migrations.ts
  - src/rooms/jev/cli.ts
  - packages/jev/src/index.ts
---

# Jev receipts, calibration and monitoring

TL;DR: Receipts capture each uncached judgment call without storing its state text; later labels support threshold reports and per-judgment monitoring.

## Purpose

A receipt records judgment/version/model, mode, project/run/subject, a state hash and size, question count, answers, decision, status, thresholds, latency, tokens and later outcome labels (`packages/jev/src/receipts.ts:9-40`, `packages/jev/src/receipts.ts:42-53`).

The `createJev` runner writes only when a DB exists, mode is not off and the provider call was not a cache hit (`packages/jev/src/run.ts:79-119`).

## How it works

### Receipt recording and relabeling lifecycle

1. **Receipt insertion**: on non-cached calls where a database is attached and mode is not off, `createJev` inserts a receipt with the redacted state's hash and character count, answer summary, field sizes, and effective thresholds (`packages/jev/src/run.ts:79-122`).
2. **Sampled input retention**: one in five deterministic input-hash samples retains redacted input JSON, capped at 8 KiB (`INPUT_JSON_CAP`), ensuring model relabelers have input context without storing plain text on all calls (`packages/jev/src/receipts.ts:58-70`).
3. **Outcome labeling**: escalated workflows or deterministic outcome sweeps attach ground-truth labels using `recordOutcome`, updating `outcome` and `outcome_at` (`packages/jev/src/receipts.ts:86-88`).
4. **Deterministic outcome sweeps**: `applyOutcomeLabels` grades receipts older than 24 hours for `critique.screen`, `critique.worth`, `lead.predict`, `guard.host_command`, and `errand.failure`, leaving records unlabeled when later truth is absent (`packages/jev/src/labels-outcome.ts:20-30`, `packages/jev/src/labels-outcome.ts:171-185`).
5. **Accuracy queries**: `judgeAccuracy` queries successful receipts (`status = 'ok'`) with an outcome, calculating `agree / (agree + disagree)` or returning null if never called (`packages/jev/src/labels-outcome.ts:192-200`).
6. **Sweep registration**: judgment owners register sweep callbacks using `registerOutcomeSweep` (`packages/jev/src/labels-outcome.ts:207-212`), which the nightly label sweep invokes via `outcomeSweepFor`.

### Threshold calibration with `calibrateReceipts`

`calibrateReceipts` processes historical receipts to evaluate accuracy and certify threshold suitability (`packages/jev/src/calibrate.ts:89-143`):

1. **Receipt querying**: selects receipts from SQLite since `sinceMs`, reading `judgment, version, model, status, decided_by, outcome, answers_json` (`packages/jev/src/calibrate.ts:91`).
2. **Cohort grouping**: groups rows by judgment ID and matches them against the registered judgment specifications (`packages/jev/src/calibrate.ts:92-97`).
3. **Metric calculation**: counts successful calls (`calls`), Jev decisions, escalations, and agree/disagree outcomes (`packages/jev/src/calibrate.ts:98-106`). Parses `answers_json` to compute average answer confidence (`packages/jev/src/calibrate.ts:107-115`).
4. **Model binding**: identifies the most frequent answering model via `jevModelBase` among successful calls (`packages/jev/src/calibrate.ts:117-119`).
5. **Source classification**: classifies outcome labels into `outcome` (later truth), `model` (nightly relabeler), and `escalated` (owner review) via `labelSource` (`packages/jev/src/calibrate.ts:120-125`).
6. **Verdict assignment**:
   - `"dead"`: zero successful calls, or labeled receipts have accuracy below 50% (`packages/jev/src/calibrate.ts:129-130`).
   - `"gate"`: labeled sample meets `minLabeled` (default 10 via `DEFAULT_MIN_LABELED`) with accuracy at least 75% (`packages/jev/src/calibrate.ts:90`, `packages/jev/src/calibrate.ts:127-131`).
   - `"sort-only"`: labeled sample is below `minLabeled` or accuracy is between 50% and 75% (`packages/jev/src/calibrate.ts:127-132`).
7. **Fingerprint generation**: attaches `judgmentFingerprint` (`packages/jev/src/calibrate.ts:134`).
The `calibrationRecord` helper formats certified thresholds for `--save` (`packages/jev/src/calibrate.ts:144-147`).

### Drift monitoring with `jevWatch`

`jevWatch` inspects recent judgment activity against a historical baseline to detect degradation (`packages/jev/src/watch.ts:79-117`):

1. **Time horizons**: defines an evaluation window starting at `sinceMs` and a comparison baseline starting at `baselineSince` (defaulting to 30 days prior) (`packages/jev/src/watch.ts:80-81`).
2. **Aggregation**: queries receipts from `lane_pilot_jev_receipt` across both periods, folding calls, latencies, token consumption, escalations, errors, and labeled outcomes into per-judgment/project buckets (`packages/jev/src/watch.ts:82-88`).
3. **Slice construction**: compiles `WatchSlice` structures comparing window accuracy and latency against baseline figures (`packages/jev/src/watch.ts:90-99`).
4. **Finding rules**: evaluates threshold triggers across six degradation kinds (`packages/jev/src/watch.ts:100-113`):
   - `went_dead`: baseline had at least 20 calls (`MIN_BASELINE_CALLS`), but the window has 0 calls or all errors (`packages/jev/src/watch.ts:102-103`).
   - `accuracy_drop`: window agreement drops by 0.15 (`DROP`) or more below baseline with at least 5 labeled calls in both (`packages/jev/src/watch.ts:104-105`).
   - `error_spike`: window error rate is at least 30% and exceeds baseline error rate by 0.20 (`ERR_SPIKE`) with at least 5 calls (`packages/jev/src/watch.ts:106-107`).
   - `escalation_spike`: escalation share reaches at least 50% and exceeds baseline by 0.30 (`ESC_SPIKE`) with at least 5 calls (`packages/jev/src/watch.ts:108-109`).
   - `latency_spike`: mean latency is at least 2,000 ms and exceeds 1.5× baseline latency (`LAT_RATIO`) with at least 5 calls (`packages/jev/src/watch.ts:110-111`).
   - `new_slice`: window has recorded calls while the baseline had zero calls (`packages/jev/src/watch.ts:112`).
5. **Output**: returns `{ sinceMs, baselineSinceMs, slices, findings }` (`packages/jev/src/watch.ts:114`).

### Daily morning reporting with `watchMorningLine`

`watchMorningLine` generates a summary line for morning operational reviews (`packages/jev/src/watch.ts:118-127`):

1. Executes `jevWatch` covering the last 24 hours (`now - 86_400_000`) (`packages/jev/src/watch.ts:119`).
2. Aggregates total call volume, error counts, and escalations across slices (`packages/jev/src/watch.ts:120-122`).
3. Filters findings excluding `new_slice` to highlight actionable degradation events (`packages/jev/src/watch.ts:123`).
4. Returns a formatted line with total counts and detected degradation signatures (`packages/jev/src/watch.ts:124-126`).

## Modes and report branches

| Operation | Input and branch | Output | Evidence |
|---|---|---|---|
| Receipt insert | Judgment call with DB, not off and not cached | Row ID; insert failure is logged by runner and yields null | `packages/jev/src/run.ts:109-127` |
| Outcome label | Receipt ID and label text | Sets `outcome` and `outcome_at` | `packages/jev/src/receipts.ts:86-88` |
| Deterministic outcome labeling | Successful, decided, unlabeled receipts older than 24 hours | Counts labels written per supported judgment; unavailable truth stays unlabeled | `packages/jev/src/labels-outcome.ts:20-30`, `packages/jev/src/labels-outcome.ts:171-185` |
| Per-judgment accuracy | Judgment ID | Labeled count and `agree / (agree + disagree)` across successful receipts, or null if zero calls | `packages/jev/src/labels-outcome.ts:192-200` |
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

`applyOutcomeLabels` applies deterministic later-truth rules and returns counts by judgment (`packages/jev/src/labels-outcome.ts:171-185`). `judgeAccuracy` returns the labeled sample size and accuracy for a judgment, or null when never called (`packages/jev/src/labels-outcome.ts:192-200`).

`pruneReceipts` removes expired or excess rows (`packages/jev/src/receipts.ts:90-93`).

`summarizeReceipts` groups receipt results (`packages/jev/src/receipts.ts:98-101`).

Reader queries for outcome sweeps and reporting provide direct queries without raw SQL: `unlabeledJevReceipts`, `unlabeledSubjectReceipts`, `unlabeledJevSubjectReceipts`, and `unlabeledRunReceipts` query unlabeled receipts (`packages/jev/src/receipts.ts:106-132`); `labeledOutcomes`, `countJudgmentReceipts`, `jevDecisionCounts`, `jevCostStats`, and `jevReceiptDecision` provide metrics (`packages/jev/src/receipts.ts:135-163`); `listPlanFactJevReceipts` and `listJevRebenchReceipts` return comparison subsets (`packages/jev/src/receipts.ts:146-149`, `packages/jev/src/receipts.ts:170-181`); `jevMaturedJudgmentCount` counts mature judgments (`packages/jev/src/receipts.ts:165-168`).

`registerOutcomeSweep` registers judgment sweep callbacks, and `outcomeSweepFor` resolves them (`packages/jev/src/labels-outcome.ts:207-212`).

`calibrateReceipts` and `calibrationRecord` build threshold reports (`packages/jev/src/calibrate.ts:89-159`).

`autoresearchThresholds` builds grid-search proposals (`packages/jev/src/autoresearch.ts:37-62`).

`jevWatch` builds monitoring reports (`packages/jev/src/watch.ts:79-137`).

Parent-plugin commands such as `bb lane-pilot jev calibrate` and `bb lane-pilot jev watch` are implemented in the CLI runner outside this workspace (`src/rooms/jev/cli.ts:16-19`, `src/rooms/jev/cli.ts:23-123`).

## Gotchas

- The receipt table's initial DDL is followed by plugin migrations adding `fields_json` (`src/rooms/migrations.ts:429`) and `input_json` (`src/rooms/migrations.ts:465`).
- Use the assembled migrations, not the initial statement alone (`packages/jev/src/receipts.ts:9-40`).
- Outcome labelers query only eligible receipts with `outcome IS NULL`, so already labeled rows do not enter their normal relabel flow (`packages/jev/src/labels-outcome.ts:22-31`).
- The CLI's `--save` writes certified thresholds into project settings; autoresearch itself returns proposals (`src/rooms/jev/cli.ts:102-106`, `packages/jev/src/autoresearch.ts:37-62`).

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
