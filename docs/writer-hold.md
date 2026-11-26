---
title: "Writer hold (H2): no attempt is spent on a writer that cannot start"
type: component
created: 2026-11-02
updated: 2026-11-16
status: active
confidence: medium
tags: [writer, hold, fallback, queue, metrics]
sources:
  - src/rooms/writer/server/services/writer-hold.ts
  - src/rooms/writer/server/services/writer-wake.ts
  - src/rooms/writer/server/services/start-writer-holds.ts
  - src/rooms/writer/server/services/start-attempt-spawn.ts
  - src/rooms/writer/server/services/start-fallback-chain.ts
  - src/rooms/writer/server/services/spawn.ts
  - src/rooms/storage/attempts-store/wake.ts
  - src/rooms/owner-presence/models/presence.ts
  - src/rooms/usage/server/services/attempt-metrics.ts
---

# Writer hold (H2): no attempt is spent on a writer that cannot start

TL;DR: `writerHold` and `walkWriterChain` check writer availability before spawning an attempt, picking the first free chain member or parking the queued attempt with `waiting_writer:` and `wake_at` (`src/rooms/writer/server/services/writer-hold.ts`, `src/rooms/writer/server/services/writer-wake.ts`).

## How it works

1. Before `spawnWriterAttempt` runs in `spawnFreshWriter` (`src/rooms/writer/server/services/start-attempt-spawn.ts`) or before `fallbackChain` launches fallbacks (`src/rooms/writer/server/services/start-fallback-chain.ts`), `walkWriterChain` evaluates each member of the writer chain (`primary` + fallbacks + PM).
2. `writerHold` checks six availability gates in order and returns `{ reason, until }` or `null` (`src/rooms/writer/server/services/writer-hold.ts`).
3. If a free member exists (or if every held member is held only by `usage_window`, index `0` is tried), `walkWriterChain` returns that member; when `money.strict` is enabled, a free subscription member is preferred over a paid member.
4. If no member is free, `parkForWriter` parks the attempt as `queued` (`parkAttemptWake`) with `reason = waiting_writer:<shortest hold reason>` and `wake_at` (`src/rooms/writer/server/services/start-writer-holds.ts`, `src/rooms/storage/attempts-store/wake.ts`), unless `allUnsupported` is true (which transitions to `blocked`).
5. `writer-wake` runs `sweepWriterWakes`, atomically clears `wake_at` with `claimAttemptWake`, and calls `startWriterTask` to re-walk the chain (`src/rooms/writer/server/services/writer-wake.ts`).

## Hold conditions (`writerHold`)

| Gate | Reason prefix | `until` recheck time | Source |
|---|---|---|---|
| Owner switch (`writer.models_off`) | `writer_provider_unavailable:writer_off:` | `now + 15 min` (`OFF_RECHECK_MS`) | `src/rooms/writer/server/services/writer-hold.ts` |
| Open circuit breaker (`snapshot`) | `writer_provider_unavailable:breaker_open:` | `openedAt + 5 min` (`BREAKER_RECHECK_MS`) | `src/rooms/writer/server/services/writer-hold.ts` |
| Owner active in BB thread | `writer_provider_unavailable:owner_present:` | `mark.at + PRESENCE_WINDOW_MS` (10 min) | `src/rooms/owner-presence/models/presence.ts` |
| Unsupported by BB core | `writer_provider_unavailable:core_unsupported:` | `null` (no wait fixes it) | `src/rooms/writer/server/services/writer-hold.ts` |
| Provider usage window nearly spent | `usageHoldReason(...)` | `resetsAt` or `now + 15 min` (`USAGE_UNKNOWN_RESET_MS`) | `src/rooms/writer/server/services/writer-hold.ts` |
| Monthly money cap (`isPaid`) | `writer_provider_unavailable:money_cap:` | 1st of next UTC month `00:00:00` | `src/rooms/writer/server/services/writer-hold.ts` |

`deps.breaker.snapshot(now)` is read instead of `decide()` so a hold check never consumes a half-open trial.

## Parked attempts and the waker

- `parkAttemptWake` journals the park as an atomic `queued → queued` transition carrying `reason` and `wake_at` (`src/rooms/storage/attempts-store/wake.ts`).
- `listDueWakes` selects queued attempts with `wake_at <= now`; `claimAttemptWake` clears `wake_at` atomically.
- If `configForRun` fails during wake, `sweepWriterWakes` re-parks the attempt with `wake_config_unreadable:`.
- When `walk.allOff` holds, `parkForWriter` posts a `writer_off` owner item (`writer-all-off:<projectId>`).
- When `walk.allUnsupported` holds, the attempt ends `blocked` and `noteUnsupportedProvider` notifies the PM once per provider.

## What people see

- **Board card:** `waitingWriterText` formats the active hold reason and minutes until recheck, recorded on the pending `writer-agent` stage.
- **PM chat:** no message of its own; the waiting task reaches the PM in the task digest (`src/rooms/relay/server/services/relay.ts`).
- **Metrics:** `attemptMetrics` exposes `attemptsPerAcceptedTask` and `heldShare` (`src/rooms/usage/server/services/attempt-metrics.ts`).

The spawn gate in `spawnWriterAttemptOnce` remains active as the final guard; `writerHold` is advisory (`src/rooms/writer/server/services/spawn.ts`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Failure handling and stability](guide/failures.md)
