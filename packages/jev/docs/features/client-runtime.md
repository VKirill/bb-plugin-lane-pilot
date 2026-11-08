---
title: Jev client and runtime
type: component
created: 2026-11-05
updated: 2026-11-08
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
  - packages/jev/src/judgments/host-command.ts
---

# Jev client and runtime

TL;DR: The runtime validates typed answers, resolves project settings, uses deterministic fallbacks when a judgment cannot decide, and sends provider requests through a bounded client.

## Purpose

`createJevClient` implements the System One HTTP request contract; `createJev` applies a registered judgment and returns a typed verdict; `installJev` creates the process instance used by `jev()` (`packages/jev/src/client.ts:49-59`, `packages/jev/src/run.ts:79-91`, `packages/jev/src/runtime.ts:14-20`).

## How it works

### Client request lifecycle with `createJevClient`

`createJevClient` manages the HTTP connection, concurrency limits, circuit breaker, retries, and standby failover (`packages/jev/src/client.ts:49-108`):

1. **Circuit breaker and concurrency tracking**: tracks recent failure timestamps (`BREAKER_WINDOW_MS = 60_000`); five failures within one minute open the breaker for five minutes (`BREAKER_FAILURES = 5`, `BREAKER_OPEN_MS = 300_000`) (`packages/jev/src/client.ts:52-61`).
Simultaneous in-flight requests are capped at 16 (`MAX_IN_FLIGHT = 16`), with surplus calls queued in `waiting` (`packages/jev/src/client.ts:102-103`).
2. **Endpoint and key resolution**: calls `deps.endpoint()`. If the reader throws, fails with `status: "error"` (`packages/jev/src/client.ts:88-90`). If no endpoint or key is present, fails with `status: "disabled"` (`packages/jev/src/client.ts:91-93`).
3. **Breaker evaluation**: if the breaker is open (`now() < openUntil`), immediately rejects with `status: "breaker_open"` (`packages/jev/src/client.ts:94`).
4. **Body serialization and validation**: builds JSON body with state, model, questions, and optional assets (`TypeSafe-Danger-Zone-Images` header attached for image or box questions) (`packages/jev/src/client.ts:66`, `packages/jev/src/client.ts:95-96`). If body length exceeds `MAX_STATE_CHARS + 200_000` (280,000 chars), rejects with `status: "invalid"` (`packages/jev/src/client.ts:97`).
5. **Run budget accounting**: decrements `options.budget.remaining` by 1; if remaining budget is zero or negative, rejects with `status: "budget"` (`packages/jev/src/client.ts:98-101`).
6. **HTTP execution and retries**: sends HTTP `POST` with timeout (`options.timeoutMs ?? DEFAULT_TIMEOUT_MS` plus `provider.timeoutPadMs`) (`packages/jev/src/client.ts:63-68`, `packages/jev/src/client.ts:105`). Retries eligible failures (network error status 0 or retryable codes 408, 429, 500, 502, 503, 504) once after sleeping for the duration in the `retry-after` header (up to 10 seconds) (`packages/jev/src/client.ts:107-113`).
7. **Standby provider failover**: if the provider response is dead or saturated (status 0, 429, 5xx, or timeout) and `endpoint.fallback` is configured with an API key, retries once against the standby provider URL (`packages/jev/src/client.ts:120-128`).
8. **Response validation**: passes the JSON payload to `parseResponse`; on success returns `{ ok: true, answers, model, usage, latencyMs, attempts }` (`packages/jev/src/client.ts:133-135`). Decrements in-flight count and wakes the next queued caller in a `finally` block (`packages/jev/src/client.ts:136-139`).

### Response validation with `parseResponse`

`parseResponse` checks provider response shapes against the asked question definitions (`packages/jev/src/client.ts:144-157`):

1. **Envelope check**: validates that the response is an object with an `answers` dictionary; returns `{ ok: false, error: "no answers in the response" }` if absent (`packages/jev/src/client.ts:145-146`).
2. **Type-specific validation**: for each defined question ID, verifies that an answer exists and that `answer.type === question.type` (`packages/jev/src/client.ts:148-150`):
   - For `noul` questions: verifies `typeof answer.noul === "number"`, returning error if missing (`packages/jev/src/client.ts:151`).
   - For `box` questions: verifies `typeof answer.box === "object" && answer.box`, returning error if missing (`packages/jev/src/client.ts:152`).
   - For all other questions (`choice`, `score`): verifies `typeof answer.probabilities === "object" && answer.probabilities`, returning error if missing (`packages/jev/src/client.ts:153`).
3. **Usage and model extraction**: returns `{ ok: true, answers, model, usage }`, defaulting input and output token numbers to 0 if absent (`packages/jev/src/client.ts:156`).

### Judgment runner execution with `createJev`

`createJev` wraps client execution, caching, threshold binding, decision evaluation, and receipt logging (`packages/jev/src/run.ts:79-138`):

1. **Answer caching**: caches successful answers in memory for five minutes (`JEV_CACHE_TTL_MS = 300_000`, up to 500 entries) keyed by SHA-256 of model, stateText, and questions (`packages/jev/src/run.ts:83-100`).
2. **Input preparation**: deeply redacts state with `redactKnownDeep`, builds questions, validates the question count does not exceed `MAX_QUESTIONS_PER_JUDGMENT` (48), measures field sizes, and resolves effective mode (`packages/jev/src/run.ts:102-107`).
3. **Execution**: if mode is `off`, skips provider request and returns deterministic fallback decision without writing a receipt (`packages/jev/src/run.ts:111`, `packages/jev/src/run.ts:150-156`). On a cache miss, submits request to `deps.client.call` (`packages/jev/src/run.ts:160-177`).
4. **Threshold binding**: calls `resolveThresholds` bound to the answering model ID (`call.model`), ensuring certified thresholds match the model that served the call (`packages/jev/src/run.ts:134`).
5. **Decision and verdict mapping**:
   - If provider call fails or answers are null: returns `{ by: "fallback", decision: fallbackDecision(), status }` (`packages/jev/src/run.ts:135-138`).
   - Executes `judgment.decide(answers, thresholds, entry.input)`. If `decide` throws, logs error and returns fallback with `status: "invalid"` (`packages/jev/src/run.ts:139-143`).
   - In `shadow` mode: returns `{ by: "fallback", decision: fallbackDecision(), status: "shadow", shadow: decided, answers }` (`packages/jev/src/run.ts:145`).
   - On escalation: returns `{ by: "escalate", to: decided.escalate, answers }` (`packages/jev/src/run.ts:146`).
   - On clean active decision: returns `{ by: "jev", decision: decided.decision, answers }` (`packages/jev/src/run.ts:147`).
6. **Receipt recording**: inserts a receipt into SQLite via `insertReceipt` on uncached calls with a database; receipt write failures are caught and logged without failing the judgment verdict (`packages/jev/src/run.ts:109-126`).

### Judgment registration with `defineJudgment`

`defineJudgment` registers a judgment contract in process memory (`packages/jev/src/registry.ts:47-53`):

1. **Identifier validation**: asserts `judgment.id` matches regex `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` (e.g. `area.name`), throwing Error on invalid characters (`packages/jev/src/registry.ts:48`).
2. **Collision detection**: verifies whether `judgments` map already holds this ID with a different instance, throwing Error if defined twice (`packages/jev/src/registry.ts:49`).
3. **Registration**: saves the contract in the module-level map `judgments.set(judgment.id, judgment)` and returns the judgment object (`packages/jev/src/registry.ts:50-51`).

### Effective threshold calculation with `resolveThresholds`

`resolveThresholds` determines numerical thresholds from defaults, certified calibration, and project settings (`packages/jev/src/thresholds.ts:35-44`):

1. **Base thresholds**: loads certified calibration via `calibratedThresholds(judgment, settings, model)` matching the judgment fingerprint and model version; if no certified calibration applies, loads `spec.default` from `judgment.thresholds` (`packages/jev/src/thresholds.ts:36`).
2. **Setting overrides**: checks project settings under `jev.thresholds` (`JEV_THRESHOLDS_KEY`) for keys matching `${judgment.id}.<threshold_name>` (`packages/jev/src/thresholds.ts:37-38`).
3. **Clamping**: verifies the threshold name exists and is a finite number, then clamps to `[spec.min, spec.max]`: `out[name] = Math.min(spec.max, Math.max(spec.min, value))` (`packages/jev/src/thresholds.ts:39-41`).
4. **Return**: returns the effective `Thresholds` map (`packages/jev/src/thresholds.ts:35-42`).

### Provider catalog with `JEV_PROVIDERS`

`JEV_PROVIDERS` defines the provider connection catalog (`packages/jev/src/provider.ts:13-19`):

- **TypeSafe**: official provider at `https://api.typesafe.ai/v1/systemone` using model `jev-1.14.0`, credentials from `TYPESAFE_API_KEY`, and 0 ms timeout headroom (`packages/jev/src/provider.ts:16`).
- **OpenLux**: reseller endpoint at `https://api.openlux.ai/v1/systemone` using pinned route model `jev-1.14.0:stable`, credentials from `OPENLUX_API_KEY`, and 1,500 ms timeout pad (`timeoutPadMs`) to compensate for proxy overhead (`packages/jev/src/provider.ts:17`).
- **Resolution and stripping**: `DEFAULT_JEV_PROVIDER` is `"typesafe"`; `resolveJevProvider` falls back to TypeSafe on unknown or missing names (`packages/jev/src/provider.ts:22`, `packages/jev/src/provider.ts:26-28`). `jevModelBase` extracts the base model ID by stripping route suffixes (`packages/jev/src/provider.ts:20`).

### Shell command safety with `hostCommandJudgment`

`hostCommandJudgment` inspects proposed agent shell commands (`packages/jev/src/judgments/host-command.ts:16-59`):

1. **State building**: clips `command` (4,000 chars), `cwd` (300 chars), up to four `workspaceRoots` (200 chars each), and `task` description (400 chars) (`packages/jev/src/judgments/host-command.ts:22-27`).
2. **Questions**: asks `kind` (Choice: `routine`, `review`, `destructive`) and `harm` (Noul: unrecoverable loss of work, money, or out-of-workspace changes) (`packages/jev/src/judgments/host-command.ts:28-41`).
3. **Decide logic**:
   - If `destructive >= stop_p` (default 0.7) or `harm >= stop_p`: returns `{ action: "stop", reason: ... }` halting step execution (`packages/jev/src/judgments/host-command.ts:49-51`).
   - Else if `kind.top === "review"` or `destructive >= review_p` (default 0.3) or `harm >= review_p`: returns `{ action: "review", reason: ... }` permitting execution with a receipt warning (`packages/jev/src/judgments/host-command.ts:52-54`).
   - Otherwise returns `{ action: "allow", reason: "routine" }` (`packages/jev/src/judgments/host-command.ts:55`).
4. **Modes and failure**: default mode is `shadow` with title `"Безопасна ли команда на машине"` and 8,000 ms timeout (`packages/jev/src/judgments/host-command.ts:18-21`).
Deterministic fallback returns `{ action: "allow", reason: "not judged" }` (`packages/jev/src/judgments/host-command.ts:57`).

## Modes, providers and limits

| Branch | Inputs and rule | Result | Evidence |
|---|---|---|---|
| `off` | `jev.enabled=false` or per-judgment mode `off` | Calls deterministic fallback; skips provider request and receipt | `packages/jev/src/thresholds.ts:29-50`; `packages/jev/src/run.ts:150-156` |
| `shadow` | Judgment default or project override | Asks Jev and records its decision; outward verdict remains fallback | `packages/jev/src/run.ts:139-146` |
| Active mode | Project mode override or active judgment default | Clear decision is returned; escalation is returned separately | `packages/jev/src/thresholds.ts:16` |
| TypeSafe | Default provider; pinned model `jev-1.14.0` | Provider URL and model are defined in the provider catalog | `packages/jev/src/provider.ts:1-18` |
| OpenLux | Explicit provider selection; pinned route model `jev-1.14.0:stable`; adds 1,500 ms timeout headroom | Provider URL and model are defined in the provider catalog | `packages/jev/src/provider.ts:1-18` |

The client sends HTTP `POST` requests with bearer authorization (`packages/jev/src/client.ts:63-70`).

The request body is capped at 80,000 state characters plus 200,000 serialized characters; the client permits 16 in-flight calls, applies a 4,000 ms default timeout plus provider headroom, retries at most once, and opens a five-minute breaker after five qualifying failures in one minute (`packages/jev/src/client.ts:14-23`, `packages/jev/src/client.ts:85-114`). Each judgment is capped at 48 questions (`packages/jev/src/registry.ts:11`, `packages/jev/src/run.ts:102-106`).

When a dead or saturated provider response occurs (status 0, 429, 5xx, timeout, or no answer) and a standby fallback provider with an API key is configured, the client retries once on the standby endpoint; a successful standby response prefixes the model with the standby provider ID (`packages/jev/src/client.ts:115-127`).

The result exposes input and output token counts; this package has no monetary price field in its usage contract (`packages/jev/src/types.ts:23-30`).

## Failure behavior

| Failure | Runtime behavior | Evidence |
|---|---|---|
| Endpoint read throws | Client returns `error` with the unreadable endpoint message | `packages/jev/src/client.ts:88-90` |
| No endpoint or API key | Client returns `disabled` | `packages/jev/src/client.ts:91-93` |
| Provider call failure or invalid answers | Runner returns judgment fallback with the failure status | `packages/jev/src/run.ts:129-137` |
| Timeout, provider error, 429 saturation, open breaker, budget exhaustion or invalid response | Typed failure status is returned and the judgment fallback runs; dead or 429-saturated providers attempt the standby provider once before failing | `packages/jev/src/client.ts:115-128`; `packages/jev/src/run.ts:120-127` |
| `decide` throws | Logs a decision failure and returns fallback with `invalid` status | `packages/jev/src/run.ts:139-142` |
| Receipt write fails | Logs the storage failure and returns a null receipt ID; judgment result remains available | `packages/jev/src/run.ts:109-127` |
| Caller aborts | No retry or standby request after abort; the call returns a failure result | `packages/jev/src/client.ts:109-127` |

## Business rules

- `choiceOf` and `noulOf` provide probability values used by decision functions (`packages/jev/src/registry.ts:63-75`).
- Answer `confidence` is recorded but does not gate decisions (`packages/jev/src/types.ts:15-20`).
- State is redacted before serialization; cache keys include model, state and questions; successful answers are cached in process memory for five minutes, up to 500 entries by default (`packages/jev/src/run.ts:50-52`, `packages/jev/src/run.ts:68-107`).
- Cache hits do not write receipts because they do not make provider calls (`packages/jev/src/run.ts:109-111`).
- Calibrated thresholds apply only when judgment fingerprint and answering model match; project overrides are applied afterward and clamped (`packages/jev/src/thresholds.ts:35-43`, `packages/jev/src/calibrate.ts:48-76`).

## Public API

`createJevClient` constructs the HTTP client (`packages/jev/src/client.ts:49-142`). `createJev` constructs the judgment runner (`packages/jev/src/run.ts:79-91`). `installJev` and `jev` manage the process instance (`packages/jev/src/runtime.ts:8-20`). `defineJudgment` and question helpers are defined in the registry (`packages/jev/src/registry.ts:47-60`).

## Gotchas

- A judgment module registers with `defineJudgment` at top level when its file is imported (`packages/jev/src/registry.ts:47-52`, `packages/jev/src/judgments/host-command.ts:16-17`).
- The package manifest records that import side effect (`packages/jev/package.json:4`).
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
