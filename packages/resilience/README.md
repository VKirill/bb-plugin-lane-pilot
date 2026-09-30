# @lane-pilot/resilience

Two small, pure mechanisms that keep long agent runs from failing loudly or spending without limit.

## Provider breaker

A breaker per `provider/model`. Transient outcomes (rate limit, overload, dropped stream) and hard
failures (provider error, not started) count inside a sliding window; past the threshold the pair
is **open** for a cooldown and the caller is told to use its fallback selection. One trial call is
allowed after the cooldown (**half-open**); a success closes the breaker again.

| Export | What it does |
|---|---|
| `createProviderBreaker(options?)` | `record(key, outcome, now?)`, `decide(key, now?)`, `snapshot()` |
| `classifyFailure(detail)` | Maps a reason string from Lane Pilot receipts or BB events to `transient`, `failure` or `product` (the last never trips the breaker) |
| `breakerKey(providerId, model)` | The key format |

## Run budget

A meter for one run: attempts, wall-clock time, tokens (from BB `thread/tokenUsage/updated`
events) and spawned child threads. `check()` names the first exceeded limit so the caller can stop
the run with a precise reason instead of a timeout.

| Export | What it does |
|---|---|
| `createRunBudget(limits, startedAt?)` | `noteAttempt()`, `noteChild()`, `noteTokens(threadId, total)`, `check(now?)`, `snapshot()` |
| `tokenUsageFromEvent(event)` | Reads `{threadId, totalTokens}` from a BB usage event, or `null` |
| `parseRunBudgetLimits(raw)` | Validates settings such as `run.max_tokens` into limits |

## Who may use it

Any plugin that spawns model threads and needs to fail over between providers or cap a run.
No dependencies.
