# @lane-pilot/thread-observe

Reads BB's own verdict on a child thread instead of a stopwatch: which turn is current, whether it
completed, and every way BB reports that it failed (provider error, system error, interrupted thread,
rejected turn, failed provisioning, a provider that never opened a session).

## Contract

| Export | What it answers |
|---|---|
| `decideThreadCompletion(input)` | Is the current turn of `threadId` done, failed, or still incomplete, given `events` and the thread status |
| `threadFailure(events, now?)` | The first terminal failure among the events after the latest request, or `null` |
| `listThreadEventsRaw(bb, query)` | A bounded `events.list` call whose errors are sanitized strings, never thrown |
| `waitThreadIdle(bb, threadId, label, probeMs?, requestedAfter?)` | Waits until the turn is done; throws with the failure detail otherwise |
| `observeStageChild(bb, threadId, timeoutMs)` | One bounded observation: `completed`, `product_failure`, or `observing` |
| `THREAD_WATCH_EVENT_TYPES`, `PROVIDER_START_LIMIT_MS` | The event types worth watching and the start limit for a silent provider |

## Who may use it

Any BB plugin that spawns threads and needs to know when they are done: Lane Pilot writers and
stages, MoA advisors, a council seat. It depends on `@get-bb/plugin-sdk` types only.
