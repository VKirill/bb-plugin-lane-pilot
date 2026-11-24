---
title: "Writer hold (H2): no attempt is spent on a writer that cannot start"
type: component
created: 2026-11-02
updated: 2026-11-16
status: active
confidence: medium
tags: [writer, hold, fallback, queue, metrics]
sources:
  - src/rooms/writer/server/writer-hold.ts
  - src/rooms/writer/server/writer-wake.ts
  - src/rooms/writer/server/start-writer-holds.ts
  - src/rooms/writer/server/start-attempt-spawn.ts
  - src/rooms/writer/server/start-fallback-chain.ts
  - src/rooms/writer/server/spawn.ts
  - src/rooms/storage/attempts-store/wake.ts
  - src/rooms/owner-presence/logic.ts
  - src/rooms/usage/server/attempt-metrics.ts
  - server.ts
---

# Writer hold (H2): no attempt is spent on a writer that cannot start

TL;DR: `writerHold` and `walkWriterChain` check writer availability before spawning an attempt, picking the first free chain member or parking the queued attempt with `waiting_writer:` and `wake_at` for the minute waker (`src/rooms/writer/server/writer-hold.ts:43-145`, `src/rooms/writer/server/writer-wake.ts:26-61`).

## How it works

1. Before `spawnWriterAttempt` runs in `spawnFreshWriter` (`src/rooms/writer/server/start-attempt-spawn.ts:46-55`) or before `fallbackChain` launches fallbacks (`src/rooms/writer/server/start-fallback-chain.ts:74-81`), `walkWriterChain` evaluates each member of the writer chain (`primary` + fallbacks + PM).
2. `writerHold` checks six availability gates in order (`src/rooms/writer/server/writer-hold.ts:43-88`) and returns `{ reason, until }` or `null`.
3. If a free member exists (or if every held member is held only by `usage_window`, in which case index `0` is tried anyway; `src/rooms/writer/server/writer-hold.ts:126`), `walkWriterChain` returns that member; when `money.strict` is enabled and the free member is paid, a free subscription member later in the chain is preferred (`src/rooms/writer/server/writer-hold.ts:129-132`).
4. If no member is free, `parkForWriter` parks the attempt as `queued` (`parkAttemptWake`) with `reason = waiting_writer:<shortest hold reason>` and `wake_at` set to the earliest `until` (`src/rooms/writer/server/start-writer-holds.ts:25-51`, `src/rooms/storage/attempts-store/wake.ts:8-11`), unless `allUnsupported` is true, in which case the attempt transitions to `blocked` (`src/rooms/writer/server/start-writer-holds.ts:35-41`).
5. Every minute (`* * * * *`), `writer-wake` runs `sweepWriterWakes` (`server.ts:603`, `src/rooms/writer/server/writer-wake.ts:26-61`), atomically clears `wake_at` with `claimAttemptWake` (`src/rooms/storage/attempts-store/wake.ts:45-47`), and calls `startWriterTask` to re-walk the chain.

## Hold conditions (`writerHold`)

| Gate | Reason prefix | `until` recheck time | Source |
|---|---|---|---|
| Owner switch (`writer.models_off`) | `writer_provider_unavailable:writer_off:` | `now + 15 min` (`OFF_RECHECK_MS`) | `src/rooms/writer/server/writer-hold.ts:35`, `:52-53` |
| Open circuit breaker (`snapshot`) | `writer_provider_unavailable:breaker_open:` | `openedAt + 5 min` (`BREAKER_RECHECK_MS`) | `src/rooms/writer/server/writer-hold.ts:37`, `:56-60` |
| Owner active in BB thread | `writer_provider_unavailable:owner_present:` | `mark.at + PRESENCE_WINDOW_MS` (10 min) | `src/rooms/writer/server/writer-hold.ts:61-65`, `src/rooms/owner-presence/logic.ts:8` |
| Unsupported by BB core | `writer_provider_unavailable:core_unsupported:` | `null` (no wait fixes it) | `src/rooms/writer/server/writer-hold.ts:66-68` |
| Provider usage window nearly spent | `usageHoldReason(...)` | `resetsAt` or `now + 15 min` (`USAGE_UNKNOWN_RESET_MS`) | `src/rooms/writer/server/writer-hold.ts:33`, `:69-74` |
| Monthly money cap (`isPaid`) | `writer_provider_unavailable:money_cap:` | 1st of next UTC month `00:00:00` | `src/rooms/writer/server/writer-hold.ts:77-82` |

`deps.breaker.snapshot(now)` is read instead of `decide()` so a hold check never consumes a half-open trial (`src/rooms/writer/server/writer-hold.ts:54-56`). Exceptions from hold sources are swallowed and treated as unheld (`src/rooms/writer/server/writer-hold.ts:84-87`).

## Parked attempts and the waker

- `parkAttemptWake` journals the park as an atomic `queued → queued` transition carrying `reason` and `wake_at` (`src/rooms/storage/attempts-store/wake.ts:8-11`).
- `listDueWakes` selects queued attempts with `wake_at <= now` (`src/rooms/storage/attempts-store/wake.ts:39-42`); `claimAttemptWake` clears `wake_at` atomically so overlapping ticks cannot spawn the same attempt twice (`src/rooms/storage/attempts-store/wake.ts:45-47`).
- If `configForRun` fails during wake, `sweepWriterWakes` re-parks the attempt for `WAKE_RETRY_MS` (`60_000` ms) with `wake_config_unreadable:` so it cannot become stranded (`src/rooms/writer/server/writer-wake.ts:17`, `:40-51`).
- When `walk.allOff` holds (all chain members disabled in `writer.models_off`), `parkForWriter` posts a `writer_off` owner item (`writer-all-off:<projectId>`) and closes it when a member starts (`src/rooms/writer/server/start-writer-holds.ts:29-34`).
- When `walk.allUnsupported` holds, the attempt ends `blocked` and `noteUnsupportedProvider` notifies the PM once per provider (`kv` key `writer-unsupported:<providerId>`) (`src/rooms/writer/server/start-writer-holds.ts:35-41`, `src/rooms/writer/server/writer-wake.ts:63-84`).

## What people see

- **Board card:** `waitingWriterText` formats the active hold reason and minutes until recheck (e.g. `Ждёт писателя: владелец работает в Claude Code, проверка через ... мин`; `src/rooms/writer/server/writer-hold.ts:163-178`), recorded on the pending `writer-agent` stage (`src/rooms/writer/server/start-writer-holds.ts:46`).
- **PM chat:** no message of its own: the waiting task reaches the PM in the task digest («Still at work (waits: …)», `src/rooms/relay/server/relay.ts`).
- **Metrics:** `attemptMetrics` exposes `attemptsPerAcceptedTask` and `heldShare` (share of attempts journaled with `waiting_writer:`) (`src/rooms/usage/server/attempt-metrics.ts:50-52`, `:200-201`, `:296`).

The spawn gate in `spawnWriterAttemptOnce` remains active as the final guard; `writerHold` is advisory (`src/rooms/writer/server/spawn.ts:64-78`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Failure handling and stability](guide/failures.md)
