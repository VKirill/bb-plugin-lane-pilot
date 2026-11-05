---
title: Jev gotchas
type: gotchas
created: 2026-11-05
updated: 2026-11-05
status: active
confidence: high
tags: [jev, gotchas, integration]
sources:
  - packages/jev/src/registry.ts
  - packages/jev/src/run.ts
  - packages/jev/src/runtime.ts
  - packages/jev/src/receipts.ts
  - packages/jev/src/output-guard.ts
  - packages/jev/package.json
  - packages/jev/src/labels-model.ts
---

# Jev gotchas

TL;DR: Jev registrations depend on imports, shadow mode never changes the caller's decision, and receipt sampling is intentionally incomplete.

## Importing judgments registers them

`defineJudgment` mutates an in-process map, and only imported judgment modules register (`packages/jev/src/registry.ts:43-55`).

The package manifest describes the judgment-import registration side effect (`packages/jev/package.json:4`).

## Shadow mode is observational

In `createJev`, `shadow` returns the judgment fallback as the actual decision and places the Jev result in the `shadow` field (`packages/jev/src/run.ts:79-146`).

## Missing runtime means no Jev instance

`jev()` returns null before installation and after disposal; callers that use it need a fallback path (`packages/jev/src/runtime.ts:8-20`).

## Receipts count cache misses

Successful cached answers are held in process memory for five minutes, up to 500 entries by default, and a hit writes no receipt; receipt counts therefore measure provider calls, not all judgment evaluations (`packages/jev/src/run.ts:50-52`, `packages/jev/src/run.ts:68-77`, `packages/jev/src/run.ts:109-111`).

## Sampled inputs are partial evidence

`sampledInput` selects one in five hashes and applies `INPUT_JSON_CAP`; truncation can make its JSON unparsable (`packages/jev/src/receipts.ts:58-70`).

The model label planner skips inputs it cannot parse (`packages/jev/src/labels-model.ts:22-37`).

Image and box judgments are excluded from model relabeling (`packages/jev/src/labels-model.ts:4-12`).

## Output guard behavior depends on active kind

Only kinds in `output-guard.kinds` use active blocking; defaults are `browser` and `errand`. Other kinds use shadow sampling even when the output judgment's mode is active (`packages/jev/src/output-guard.ts:28-33`, `packages/jev/src/output-guard.ts:103-114`).

## Block merging assumes one guard instance per KV store

The append path merges concurrent writes held by one guard instance, but the implementation comment records that two instances sharing one KV store can still lose a block during overlapping get/append/set operations (`packages/jev/src/output-guard.ts:69-71`, `packages/jev/src/output-guard.ts:72-96`).

## Related pages

- [Client and runtime](features/client-runtime.md)
- [Output guard](features/output-guard.md)
- [Receipt calibration and monitoring](features/receipt-calibration.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Jev workspace overview](overview.md)
