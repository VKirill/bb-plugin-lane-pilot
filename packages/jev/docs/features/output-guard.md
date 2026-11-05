---
title: Jev output guard
type: component
created: 2026-11-05
updated: 2026-11-05
status: active
confidence: medium
tags: [jev, output-guard, redaction]
sources:
  - packages/jev/src/output-guard.ts
  - packages/jev/src/judgments/output-guard.ts
  - packages/jev/src/run.ts
  - packages/jev/src/thresholds.ts
  - src/rooms/core/server/core.ts
  - packages/jev/package.json
  - packages/jev/src/index.ts
---

# Jev output guard

TL;DR: The output guard redacts known secrets, samples eligible text for Jev injection checks, and withholds text when the judgment reports a block.

## Purpose

`createOutputGuard` returns an async guard function for outputs tagged with a kind, project, and optional run or subject (`packages/jev/src/output-guard.ts:40-55`). The core server installs it with the Jev accessor, project settings and key-value storage (`src/rooms/core/server/core.ts:416`).

## How it works

1. The guard redacts known secrets and obtains the installed Jev instance; without an instance it returns the redacted text (`packages/jev/src/output-guard.ts:98-105`).
2. In shadow mode, text changed by redaction or matching credential patterns is counted as sensitive and skipped; the caller receives the redacted text (`packages/jev/src/output-guard.ts:23-27`, `packages/jev/src/output-guard.ts:108-112`).
3. For eligible text, the guard applies kind settings and deterministic sampling, then asks `outputGuard` through the installed Jev runtime (`packages/jev/src/output-guard.ts:114-115`).
4. A model block records the event and returns withheld text; an allowed or unavailable judgment returns the redacted text (`packages/jev/src/output-guard.ts:90-106`).

## Modes and bounds

| Branch | Behavior | Evidence |
|---|---|---|
| Default active kinds | `browser` and `errand` | `packages/jev/src/output-guard.ts:31-33` |
| Shadow sample | 10% of eligible calls; clips judgment text to 2,000 characters | `packages/jev/src/output-guard.ts:21-23`, `packages/jev/src/output-guard.ts:108-114` |
| Active guard | Applies the judgment to kinds listed in `output-guard.kinds` (default: browser and errand); other kinds remain shadow sampled | `packages/jev/src/output-guard.ts:28-33`, `packages/jev/src/output-guard.ts:106-114` |
| Minimum input length | Text shorter than 40 characters is returned without asking Jev | `packages/jev/src/output-guard.ts:18-20`, `packages/jev/src/output-guard.ts:90-93` |
| History storage | Block records capped at 50; daily stats retained for 14 days | `packages/jev/src/output-guard.ts:17-18`, `packages/jev/src/output-guard.ts:34-35`, `packages/jev/src/output-guard.ts:89-90` |

## Failure behavior

- In shadow mode, text changed by redaction or matching credential patterns increments `sensitive` and skips the request (`packages/jev/src/output-guard.ts:108-112`).
- If Jev is absent, disabled, or returns fallback, the function returns redacted text; it does not convert the failure into a block (`packages/jev/src/output-guard.ts:90-106`).
- A rejected storage operation is logged or handled by the guard's local error path; callers still receive the guard result (`packages/jev/src/output-guard.ts:47-61`, `packages/jev/src/output-guard.ts:99-106`).

## Business rules

Kinds default to `browser` and `errand`; `output-guard.kinds` selects which kinds use active blocking, while other kinds remain shadow sampled. `jev.enabled` is the global feature switch (`packages/jev/src/output-guard.ts:28-33`, `packages/jev/src/output-guard.ts:103-114`). Guard reasons are `secret` and `injection`, and stored blocks carry project, run, subject, kind and timestamp fields (`packages/jev/src/output-guard.ts:37-45`). Thresholds separately control the probability required to block for a secret or an injection (`packages/jev/src/judgments/output-guard.ts:44-52`).

## Public API or commands

`createOutputGuard` builds the guard function (`packages/jev/src/output-guard.ts:47-55`). `looksSensitive` checks the redacted text (`packages/jev/src/output-guard.ts:23-27`); `withheldText` builds a placeholder (`packages/jev/src/output-guard.ts:44-45`). The `outputGuard` judgment is defined here (`packages/jev/src/judgments/output-guard.ts:22-56`). There are no direct commands in this workspace.

## Gotchas

- Sensitive text in shadow mode skips the request and returns redacted text; it does not create a block record (`packages/jev/src/output-guard.ts:108-112`).
- The output guard's local blocks and stats use injected key-value storage; the Jev receipt database remains a separate record path (`packages/jev/src/output-guard.ts:47-61`, `packages/jev/src/run.ts:109-119`).

## Related pages

- [Typed judgments](typed-judgments.md)
- [Client and runtime](client-runtime.md)
- [Data model](../data-model.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Output-guard state](../data-model/output-guard.md)
- [Jev gotchas](../gotchas.md)
- [Jev workspace overview](../overview.md)
