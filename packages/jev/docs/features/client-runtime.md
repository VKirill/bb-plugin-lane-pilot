---
title: Jev client and runtime
type: component
created: 2026-11-05
updated: 2026-11-05
status: active
confidence: medium
tags: [jev, client, runtime]
sources:
  - packages/jev/src/client.ts
  - packages/jev/src/provider.ts
  - packages/jev/src/run.ts
  - packages/jev/src/runtime.ts
  - packages/jev/src/registry.ts
  - packages/jev/src/thresholds.ts
  - packages/jev/src/types.ts
  - packages/jev/src/calibrate.ts
  - packages/jev/src/index.ts
  - packages/jev/package.json
  - src/rooms/core/server/core.ts
---

# Jev client and runtime

TL;DR: The runtime validates typed answers, resolves project settings, uses deterministic fallbacks when a judgment cannot decide, and sends provider requests through a bounded client.

## Purpose

`createJevClient` implements the System One HTTP request contract; `createJev` applies a registered judgment and returns a typed verdict; `installJev` creates the process instance used by `jev()` (`packages/jev/src/client.ts:49-59`, `packages/jev/src/run.ts:79-91`, `packages/jev/src/runtime.ts:13-20`).

## How it works

1. The caller supplies an endpoint reader, optional database, and optional log callback to `installJev`; the server invokes it during plugin startup (`packages/jev/src/runtime.ts:13-20`, `src/rooms/core/server/core.ts:101`).
2. A judgment builds a redacted state and typed questions. The runner enforces the 48-question per-judgment limit and resolves mode and thresholds from context settings (`packages/jev/src/run.ts:93-107`, `packages/jev/src/registry.ts:11`).
3. The runner groups entries sharing a state and model, splits requests at the question/state limits, and submits through the client (`packages/jev/src/run.ts:145-180`, `packages/jev/src/client.ts:12-23`).
4. The client requires an endpoint and non-empty key, enforces a run budget and 16 in-flight call ceiling, retries eligible errors once, and validates each answer against its question type (`packages/jev/src/client.ts:65-138`, `packages/jev/src/client.ts:141-154`).
5. The runner returns `jev`, `escalate` or `fallback`; shadow mode records the computed answer but returns the judgment's fallback (`packages/jev/src/run.ts:34-46`, `packages/jev/src/run.ts:130-142`).

## Modes, providers and limits

| Branch | Inputs and rule | Result | Evidence |
|---|---|---|---|
| `off` | `jev.enabled=false` or per-judgment mode `off` | Calls deterministic fallback; skips provider request and receipt | `packages/jev/src/thresholds.ts:29-50`; `packages/jev/src/run.ts:150-156` |
| `shadow` | Judgment default or project override | Asks Jev and records its decision; outward verdict remains fallback | `packages/jev/src/run.ts:139-146` |
| Active mode | Project mode override or active judgment default | Clear decision is returned; escalation is returned separately | `packages/jev/src/thresholds.ts:16` |
| TypeSafe | Default provider; pinned model `jev-1.14.0` | Provider URL and model are defined in the provider catalog | `packages/jev/src/provider.ts:1-18` |
| OpenLux | Explicit provider selection; pinned route model `jev-1.14.0:stable`; adds 1,500 ms timeout headroom | Provider URL and model are defined in the provider catalog | `packages/jev/src/provider.ts:1-18` |

The client sends HTTP `POST` requests with bearer authorization (`packages/jev/src/client.ts:63-68`).

The request body is capped at 80,000 state characters plus 200,000 serialized characters; the client permits 16 in-flight calls, applies a 4,000 ms default timeout plus provider headroom, retries at most once, and opens a five-minute breaker after five qualifying failures in one minute (`packages/jev/src/client.ts:14-23`, `packages/jev/src/client.ts:65-110`). Each judgment is capped at 48 questions (`packages/jev/src/registry.ts:11`, `packages/jev/src/run.ts:102-106`).

The result exposes input and output token counts; this package has no monetary price field in its usage contract (`packages/jev/src/types.ts:23-30`).

## Failure behavior

| Failure | Runtime behavior | Evidence |
|---|---|---|
| No endpoint or API key | Client returns `disabled` | `packages/jev/src/client.ts:88-91` |
| Provider call failure or invalid answers | Runner returns judgment fallback with the failure status | `packages/jev/src/run.ts:129-137` |
| Timeout, provider error, open breaker, budget exhaustion or invalid response | Typed failure status is returned and the judgment fallback runs | `packages/jev/src/types.ts:25-30`; `packages/jev/src/run.ts:120-127` |
| `decide` throws | Logs a decision failure and returns fallback with `invalid` status | `packages/jev/src/run.ts:139-142` |
| Receipt write fails | Logs the storage failure and returns a null receipt ID; judgment result remains available | `packages/jev/src/run.ts:109-127` |
| Caller aborts | No retry or standby request after abort; the call returns a failure result | `packages/jev/src/client.ts:100-126` |

## Business rules

- `choiceOf` and `noulOf` provide probability values used by decision functions (`packages/jev/src/registry.ts:60-74`).
- Answer `confidence` is recorded but does not gate decisions (`packages/jev/src/types.ts:15-20`).
- State is redacted before serialization; cache keys include model, state and questions; successful answers are cached in process memory for five minutes, up to 500 entries by default (`packages/jev/src/run.ts:50-52`, `packages/jev/src/run.ts:68-107`).
- Cache hits do not write receipts because they do not make provider calls (`packages/jev/src/run.ts:109-111`).
- Calibrated thresholds apply only when judgment fingerprint and answering model match; project overrides are applied afterward and clamped (`packages/jev/src/thresholds.ts:35-43`, `packages/jev/src/calibrate.ts:48-76`).

## Public API

`createJevClient` constructs the HTTP client (`packages/jev/src/client.ts:49-59`). `createJev` constructs the judgment runner (`packages/jev/src/run.ts:79-91`). `installJev` and `jev` manage the process instance (`packages/jev/src/runtime.ts:8-20`). `defineJudgment` and question helpers are defined in the registry (`packages/jev/src/registry.ts:43-59`).

## Gotchas

- A judgment module registers by import side effect (`packages/jev/src/registry.ts:43-55`). The package manifest describes that import side effect (`packages/jev/package.json:4`).
- `jev()` is `null` until installed and after its disposer runs (`packages/jev/src/runtime.ts:8-20`).
- `shadow` is not a partial active mode: the outward decision is always the configured deterministic fallback (`packages/jev/src/run.ts:139-146`).

## Related pages

- [Typed judgments](typed-judgments.md)
- [Receipt calibration and monitoring](receipt-calibration.md)
- [Overview](../overview.md)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Jev output guard](output-guard.md)
- [Jev receipts, calibration and monitoring](receipt-calibration.md)
- [Typed judgments](typed-judgments.md)
- [Jev gotchas](../gotchas.md)
- [Jev workspace overview](../overview.md)
