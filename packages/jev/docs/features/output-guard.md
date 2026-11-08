---
title: Jev output guard
type: component
created: 2026-11-05
updated: 2026-11-08
status: active
confidence: high
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

`createOutputGuard` returns an async guard function for outputs tagged with a kind, project, and optional run or subject (`packages/jev/src/output-guard.ts:47-55`). The core server installs it with the Jev accessor, project settings and key-value storage (`src/rooms/core/server/core.ts:421`).

## How it works

### Guard execution with `createOutputGuard`

`createOutputGuard` returns an async filter function wrapping the Jev judgment pipeline (`packages/jev/src/output-guard.ts:47-55`):

1. **Dependency binding**: receives the runtime accessor `deps.jev()`, project `settings` resolver, `kv` storage for metrics and blocks, `log` callback, and optional timestamp and random generators (`packages/jev/src/output-guard.ts:47-55`).
2. **Initial redaction**: runs `redactKnown(input.text)` to mask known secrets before any analysis (`packages/jev/src/output-guard.ts:99`).
3. **Availability and length gates**: if `deps.jev()` is null, returns `{ blocked: false, text }` (`packages/jev/src/output-guard.ts:100-101`); if trimmed text length is below `MIN_CHARS` (40 characters), returns `{ blocked: false, text }` without invoking Jev (`packages/jev/src/output-guard.ts:19`, `packages/jev/src/output-guard.ts:102`).
4. **Settings resolution**: resolves project settings via `deps.settings(input.projectId)`; if unreadable, defaults to empty settings (`packages/jev/src/output-guard.ts:105`). If Jev is disabled in settings, returns `{ blocked: false, text }` (`packages/jev/src/output-guard.ts:106`).
5. **Mode and active kinds**: checks `output-guard.kinds` (`GUARD_KINDS_KEY`), defaulting to `browser` and `errand` (`packages/jev/src/output-guard.ts:31-32`, `packages/jev/src/output-guard.ts:107-108`). Evaluates as shadow mode if judgment mode is not active or `input.kind` is not in active kinds (`packages/jev/src/output-guard.ts:109`).
6. **Shadow gating and sampling**: in shadow mode, text matching `looksSensitive(input.text, text)` increments the daily `sensitive` counter and returns `{ blocked: false, text }` (`packages/jev/src/output-guard.ts:24-25`, `packages/jev/src/output-guard.ts:110-111`).
Deterministic sampling checks `SHADOW_SAMPLE` (10%); unsampled text increments `notSampled` and returns `{ blocked: false, text }` (`packages/jev/src/output-guard.ts:21`, `packages/jev/src/output-guard.ts:112`).
7. **Judgment request**: increments the daily `asked` counter (`packages/jev/src/output-guard.ts:114`) and executes `instance.judge(outputGuard, ...)` with text limited to `SHADOW_CHARS` (2,000 chars) in shadow mode or `GUARD_CHARS` (6,000 chars) in active mode (`packages/jev/src/judgments/output-guard.ts:19-20`, `packages/jev/src/output-guard.ts:22`, `packages/jev/src/output-guard.ts:115`).
8. **Verdict handling**: if `verdict.by === "jev"` and `verdict.decision.blocked === true`, calls `appendBlock` to persist a `GuardBlock` in key-value storage, logs the incident, and returns `{ blocked: true, text: withheldText(input.kind, reason), reason }` (`packages/jev/src/output-guard.ts:44-45`, `packages/jev/src/output-guard.ts:117-121`). An allowed decision returns `{ blocked: false, text }` (`packages/jev/src/output-guard.ts:116`).
9. **Failure fallback**: errors during judgment or settings evaluation return `{ blocked: false, text }` without blocking (`packages/jev/src/output-guard.ts:122`).

### Screening judgment with `outputGuard`

The registered `outputGuard` judgment (`packages/jev/src/judgments/output-guard.ts:22-56`) operates in three steps:

1. **State construction**: `stateBuilder` records `produced_by: input.kind` and extracts the beginning and end of the text via `clipForGuard(input.text, input.limit)` (`packages/jev/src/judgments/output-guard.ts:20`, `packages/jev/src/judgments/output-guard.ts:27`).
2. **Question formulation**: `questions` asks two Noul questions: `secret` (evaluating whether API keys, private keys, passwords or credentials appear in full) and `injection` (evaluating whether text contains prompt injection instructions directed at the agent) (`packages/jev/src/judgments/output-guard.ts:28-43`).
3. **Decision logic**: `decide` reads `noulOf(answers, "secret")` and `noulOf(answers, "injection")`:
   - If `secret >= t.block_secret` (default 0.85) and `secret >= injection`: returns `{ decision: { blocked: true, reason: "secret" } }` (`packages/jev/src/judgments/output-guard.ts:45`, `packages/jev/src/judgments/output-guard.ts:50`).
   - Else if `injection >= t.block_injection` (default 0.9): returns `{ decision: { blocked: true, reason: "injection" } }` (`packages/jev/src/judgments/output-guard.ts:46`, `packages/jev/src/judgments/output-guard.ts:51`).
   - Otherwise returns `{ decision: { blocked: false } }` (`packages/jev/src/judgments/output-guard.ts:52`).
4. **Modes, bounds and fallback**: default mode is `shadow` with an 8,000 ms timeout window bounded by 5,000 ms judgment timeout (`packages/jev/src/judgments/output-guard.ts:25-26`).
Deterministic fallback returns `{ blocked: false }` (`packages/jev/src/judgments/output-guard.ts:54`).

## Modes and bounds

| Branch | Behavior | Evidence |
|---|---|---|
| Default active kinds | `browser` and `errand` | `packages/jev/src/output-guard.ts:31-32` |
| Shadow sample | 10% of eligible calls; clips judgment text to 2,000 characters | `packages/jev/src/output-guard.ts:21-22`, `packages/jev/src/output-guard.ts:110-113` |
| Active guard | Applies the judgment to kinds listed in `output-guard.kinds` (default: browser and errand); other kinds remain shadow sampled | `packages/jev/src/output-guard.ts:28-32`, `packages/jev/src/output-guard.ts:106-114` |
| Minimum input length | Text shorter than 40 characters is returned without asking Jev | `packages/jev/src/output-guard.ts:19`, `packages/jev/src/output-guard.ts:102` |
| History storage | Block records capped at 50; daily stats retained for 14 days | `packages/jev/src/output-guard.ts:17-18`, `packages/jev/src/output-guard.ts:33-34`, `packages/jev/src/output-guard.ts:65`, `packages/jev/src/output-guard.ts:89-90` |

## Failure behavior

- In shadow mode, text changed by redaction or matching credential patterns increments `sensitive` and skips the request (`packages/jev/src/output-guard.ts:110-112`).
- If Jev is absent, disabled, or returns fallback, the function returns redacted text; it does not convert the failure into a block (`packages/jev/src/output-guard.ts:100-106`, `packages/jev/src/output-guard.ts:116-122`).
- A rejected storage operation during stats or block recording is caught in best-effort blocks and does not overwrite existing data; callers still receive the guard result (`packages/jev/src/output-guard.ts:59-67`, `packages/jev/src/output-guard.ts:76-96`, `packages/jev/src/output-guard.ts:121-122`).

## Business rules

Kinds default to `browser` and `errand`; `output-guard.kinds` selects which kinds use active blocking, while other kinds remain shadow sampled (`packages/jev/src/output-guard.ts:28-32`, `packages/jev/src/output-guard.ts:106-114`).
`jev.enabled` is the global feature switch (`packages/jev/src/output-guard.ts:106`).
Stored `GuardBlock` entries carry project, run, subject, kind, reason and timestamp fields (`packages/jev/src/output-guard.ts:37-39`, `packages/jev/src/output-guard.ts:118-121`).
Guard reasons are `secret` and `injection` (`packages/jev/src/output-guard.ts:40`).
Thresholds separately control the probability required to block for a secret or an injection (`packages/jev/src/judgments/output-guard.ts:44-52`).

## Public API or commands

`createOutputGuard` builds the guard function (`packages/jev/src/output-guard.ts:47-55`). `looksSensitive` checks the redacted text (`packages/jev/src/output-guard.ts:24-25`); `withheldText` builds a placeholder (`packages/jev/src/output-guard.ts:44-45`). The `outputGuard` judgment is defined here (`packages/jev/src/judgments/output-guard.ts:22-56`). There are no direct commands in this workspace.

## Gotchas

- Sensitive text in shadow mode skips the request and returns redacted text; it does not create a block record (`packages/jev/src/output-guard.ts:110-112`).
- The output guard's local blocks and stats use injected key-value storage; the Jev receipt database remains a separate record path (`packages/jev/src/output-guard.ts:47-55`, `packages/jev/src/run.ts:109-119`).

## Related pages

- [Typed judgments](typed-judgments.md)
- [Client and runtime](client-runtime.md)
- [Data model](../data-model.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Output-guard state](../data-model/output-guard.md)
- [Jev gotchas](../gotchas.md)
- [Jev workspace overview](../overview.md)
