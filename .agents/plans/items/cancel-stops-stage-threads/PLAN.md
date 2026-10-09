# Cancelling a task also stops its running pm-read / plan-critique helper threads

## Evidence (2026-10-09, this run)
- Tasks `fallback-continues-session` and `update-task-after-question` were canceled with `lane_pilot_cancel_task` while their pm-read stage was running on an exhausted Gemini model. The tasks show `canceled`, but their pm-read helper threads (thr_zwmmyztbbk, thr_i4deri5qe8) kept running («Работаю…» on Gemini) and the stage receipts stayed `pm-read: running`. The owner saw them and took the tasks as stuck.
- `lane_pilot_cancel_task` (src/rooms/tools/server/tools.ts ~L85) calls `cancelAttemptById` (src/rooms/runs/server/cancel.ts) per open attempt; it ends the queued attempt and its writer stages, but nothing stops a stage child thread (pm-read, plan-critique, specialist-review) that is still running, and its receipt is not closed.

## Change
1. In `cancelAttemptById` (or the cancel tool right after it), for the canceled task find the stage receipts of this run/task that are `running`/`pending` and carry a `threadId` (pm-read, plan-critique, specialist-review): stop that thread's turn (`bb.sdk.threads.stop`, ignore errors on an already idle/missing thread) and close the receipt as `canceled` with reason `task canceled`. Receipts without a thread are closed `canceled` too.
2. A stage helper that finishes after the cancel must not reopen the receipt or start the writer (check the existing guard at dispatch.ts ~L254 still holds).
3. No change for accepted or blocked tasks.

## Tests
- Cancel of a queued task whose pm-read receipt is running with a threadId → threads.stop called for that thread, receipt state `canceled`.
- A stop error is ignored and the cancel still succeeds.
- A late pm-read result after cancel does not change the canceled receipt.

## Delivery
- [x] Accepted in Lane Pilot run `lprun_987d16c051234cf4b4be09cff5817a86` on 2026-10-09.
