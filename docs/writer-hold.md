# Writer hold (H2): no attempt is spent on a writer that cannot start

Until 0.1.4xx the availability check ran inside `spawnWriterAttempt`, after the attempt row existed: breaker, owner
presence, core allowlist, usage window. Every refusal ended `spawn_rejected` and retried — a row, a worktree and a PM
turn for a task nobody did anything wrong on (hub, week to 2026-11-02: 61 % of all attempts).

## writerHold — `src/rooms/writer/server/writer-hold.ts`

Pure async check of one provider/model from the same sources the spawn gate uses:

- breaker → `until` the next half-open (+5 min when none is named);
- owner presence → `until` mark + `PRESENCE_WINDOW_MS` (10 min);
- core allowlist (`core_unsupported`) → `until: null`, no wait fixes it;
- usage window → `until` its `resetsAt`, else +15 min.

The breaker is read through `snapshot()`, not `decide()` — a hold check must not spend the half-open trial.

`walkWriterChain(members, input, deps)` walks the whole chain (the task's writer, its fallbacks, the PM) and returns
the first free member, or — when all are held — the shortest hold and the earliest `wakeAt`. `allUnsupported` is true
only when every member is `core_unsupported`.

## Parked attempts

When the walk finds nobody free, the attempt is not spent and not failed: it stays `queued` with
`reason = waiting_writer:<shortest hold reason>` and `wake_at` = the earliest hold end
(`lane_pilot_attempt.wake_at`, append-only migration). `parkAttemptWake` journals the wait as a `queued → queued`
transition, so the cost report can read it.

When every member is `core_unsupported` the attempt ends `blocked` as before — and the owner hears **once per
provider** (`noteUnsupportedProvider`, kv `writer-unsupported:<providerId>`) which setting to change, not once per
task.

## The waker — `src/rooms/writer/server/writer-wake.ts`

`writer-wake` schedule, every minute: `listDueWakes` finds parked attempts with `wake_at <= now`,
`claimAttemptWake` clears `wake_at` once (two ticks cannot spawn the same attempt twice), and `startWriterTask`
re-walks the chain. A still-held attempt is parked again with a pushed `wake_at` and a refreshed board line; a hold
that ended early is simply caught by the next tick.

Where the walk happens:

- before `spawnWriterAttempt` in the writer loop (`start.ts`): the first free member spawns **in the same attempt** —
  the next chain member when the task's writer is held (`writerSettings` overlay, the normal gate still applies);
- before each emergency-fallback attempt: held fallbacks are skipped, nobody free parks one queued attempt.

## What people see

- Board card: «Ждёт писателя: владелец работает в Claude Code, проверка через 8 мин» (the writer-agent pending
  reason, `waitingWriterText`).
- PM: one line when the wait starts («задача X ждёт свободного писателя…», kv `writer-wait-told:<attemptId>`),
  nothing per tick.
- Metrics (`attemptMetrics`, `acceptance_stats`, `bb lane-pilot metrics`): `attemptsPerAcceptedTask` and `heldShare`
  (attempts journaled `waiting_writer:` / all).

The spawn gate in `spawn.ts` keeps every check — the hold is advisory, the gate is the last line of defence.

A usage window «nearly spent» on every member of the chain is a forecast, not a refusal: `walkWriterChain` then picks the writer itself (the rule of the old pre-block: nothing is skipped when no other pair has room) instead of parking the task until the windows reset. A hard hold anywhere — the owner at the keyboard, an open breaker, the core's allowlist — parks as described above.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Failure handling and stability](guide/failures.md)
