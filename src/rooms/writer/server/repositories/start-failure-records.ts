import { failureClass } from "../../../contracts";
import { listTaskAttemptRows, openDatabase } from "../../../storage";

/** A failure that was the task's own (a stray file, a red check), not its provider's, Lane Pilot's or the machine's. */
export const isOwnFailure = (outcome:Record<string, unknown>) =>
  ["task", "contract"].includes(failureClass(String(outcome.status), typeof outcome.reason === "string" ? outcome.reason : null));

/** The attempt's own check failed (its structured failure_code), as opposed to a merge, a stray file or a provider fault. */
export const verificationFailure = (outcome:Record<string, unknown>):boolean =>
  outcome.failureCode === "verification_failed" || outcome.failureCode === "verification_timeout";

/**
 * The task's last own failure before this start (a retry from the board, a restart of a parked task, a reload): a writer
 * that starts fresh was told nothing of it and redid it (vf-s4-items 2026-10-24, «owns_paths rejected …/Buffs.luau» twice).
 * An acceptance since then clears it.
 */
export function lastOwnFailure(db:ReturnType<typeof openDatabase>, runId:string, taskId:string, exceptAttemptId:string):Record<string, unknown>|null {
  const rows = listTaskAttemptRows(db, runId, taskId);
  for (const row of rows) {
    if (row.id === exceptAttemptId) continue;
    if (row.state === "accepted") return null;
    if (row.reason && isOwnFailure({ status:row.state, reason:row.reason })) return { status:row.state, reason:row.reason, ...(row.check_name ? { checkName: row.check_name } : {}) };
  }
  return null;
}
