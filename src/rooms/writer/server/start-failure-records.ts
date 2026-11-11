import { taskFamily } from "@lane-pilot/contracts";
import { failureClass } from "../../contracts";
import { listAttemptsInStates, listTaskAttemptRows, openDatabase } from "../../storage";

/** The latest charged failure of a task's family (its redispatches and mainfixes), to seed the repeated-failure stop. */
export function familyFailureRecord(db:ReturnType<typeof openDatabase>, runId:string, taskId:string):{ state:string; reason:string|null } | null {
  const family = taskFamily(taskId);
  const rows = listAttemptsInStates(db, runId, ["provider_error","timeout","empty_output","validation_failed","spawn_rejected"]);
  const other = rows.filter((row) => row.task_id !== taskId && taskFamily(row.task_id) === family);
  const last = other.at(-1);
  return last ? { state:last.state, reason:last.reason } : null;
}

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
