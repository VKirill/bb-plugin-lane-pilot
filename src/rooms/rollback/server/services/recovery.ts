import { failureClass } from "../../../contracts";
import { hasReconcileCursor } from "../../../storage";
import { effectState, type RecoveryState } from "../../models";
import { getAttemptChange, readAttemptRecoveryRow, type RollbackDb } from "../repositories/attempt-change-repository";
import { listTaskReceipts } from "../repositories/receipt-repository";

/**
 * The recovery state of an attempt (SMA ac_recovery): reconciling while the world is still being read (a spawn whose
 * fate is unknown, a reconcile scan in flight, an uncertain effect), rollback_failed while the last revert stands
 * failed or errored, needs_decision while the attempt sits blocked on a judgment, a contract or the owner's word,
 * clear otherwise. Dispatch, retry and answer_writer refuse anything not clear.
 */
export function recoveryState(db: RollbackDb, attemptId: string): RecoveryState {
  const attempt = readAttemptRecoveryRow(db, attemptId);
  if (!attempt) return "clear";
  if (attempt.state === "spawn_unknown") return "reconciling";
  if (hasReconcileCursor(db as never, attemptId)) return "reconciling";
  if (effectState(getAttemptChange(db, attemptId)) === "uncertain") return "reconciling";
  const revert = listTaskReceipts(db, attempt.task_id, "revert").at(-1);
  if (revert && (revert.state === "failed" || revert.state === "error")) return "rollback_failed";
  if (attempt.state === "blocked") {
    const reason = attempt.reason ?? "";
    const cls = failureClass(attempt.state, reason);
    if (cls === "judgment" || cls === "contract" || reason.startsWith("owner_word")) return "needs_decision";
  }
  return "clear";
}
