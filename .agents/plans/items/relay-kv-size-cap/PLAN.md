# Relay: keep relay:items under the KV size limit

## Bug (verified 2026-10-09 by the PM)
`lane_pilot_relay {action:"remind"}` fails with `tool_failed: kv value for "relay:items" is 262400 bytes; the limit is 262144 (256KB)`. src/rooms/relay/server/relay.ts stores every ask/reminder in one KV key (`KEY = "relay:items"`, load/save in relayFor). `createRelay().update()` only prunes items older than `RELAY_LIMITS.keepMs` (7 days) that are finished (a fired reminder or an answered ask). In a busy week the list grows past 256 KB, every save throws, and new reminders and asks stop working for all PM chats. Because update() saves after work(), an ask/remind that already sent or scheduled a queued message can also fail to persist.

## Fix
In `createRelay().update()` (pure, testable through RelayDeps), after the age cutoff, bound the size of the stored list. Pick a budget well under the limit, e.g. `RELAY_LIMITS.maxStoredBytes = 200_000`, measured as `Buffer.byteLength(JSON.stringify(items))`. While it is over:
1. Drop finished items first (fired reminders, answered asks), oldest `createdAt` first.
2. If it is still over, cut long free-text fields (question/answer/note/text) of the remaining items to a short prefix with «…».
3. Open items (unfired reminders, unanswered asks) are never dropped.

Add `maxStoredBytes` to RELAY_LIMITS. No storage-backend migration (KV stays). Keep the existing behaviour and limits otherwise.

## Checks
New tests/relay-size-cap.test.ts using createRelay with in-memory deps:
- With 2000 fired reminders carrying long notes plus 3 open ones, a new remind succeeds. The saved JSON is ≤ maxStoredBytes. All open items are kept, and the dropped ones are the oldest finished.
- When only open items are left and they are over budget, their long text fields are cut and none of them is removed.
Existing relay tests (tests/relay-retarget.test.ts, tests/relay-stale-state.test.ts) keep passing.

## Delivery
- [x] Relay storage now stays within its byte budget by pruning finished items and truncating long text — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `9c171e5`.
