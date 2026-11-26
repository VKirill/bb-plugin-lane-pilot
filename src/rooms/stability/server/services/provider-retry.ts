import { isOpenAttemptState } from "../../../contracts";
import { getAttempt, getRun, latestFamilyAttemptInRun, newestAttemptIdForThread, type LanePilotDatabase } from "../../../storage";
import type { RetryEligibility } from "../../models/provider-retry";

/**
 * May a queued provider retry of a failed turn in `threadId` still run? One durable answer for the consent call, the
 * late-queued check and the stream-retry gate. Only positive evidence declines: the thread's newest attempt ended
 * (any non-open state, `cancel_requested` included — the stop is already under way), a newer attempt of the same task
 * family exists in the run (redispatch, «T1» → «T1.2»), or the run is closed/accepted. No attempt on the thread means
 * no durable evidence — PM, helper, probe and native threads answer `unknown` and keep whatever the caller's own
 * ownership check says. The turn's `requestId` is not persisted, so this is a thread/attempt/run decision, not a
 * per-request fence.
 */
export function retryEligibility(db: LanePilotDatabase, threadId: string): RetryEligibility {
  const attemptId = newestAttemptIdForThread(db, threadId);
  const attempt = attemptId ? getAttempt(db, attemptId) : undefined;
  if (!attempt) return { kind: "unknown" };
  if (!isOpenAttemptState(attempt.state) || attempt.state === "cancel_requested") {
    return { kind: "decline", reason: `attempt ${attempt.state}` };
  }
  const familyLatest = latestFamilyAttemptInRun(db, attempt.run_id, attempt.task_id);
  if (familyLatest && familyLatest.id !== attempt.id) {
    return { kind: "decline", reason: "superseded by a newer attempt" };
  }
  const run = getRun(db, attempt.run_id);
  if (run && (run.closed_at !== null || run.state === "closed" || run.state === "accepted")) {
    return { kind: "decline", reason: `run ${run.state}` };
  }
  return { kind: "allow", reason: `attempt ${attempt.state}` };
}
