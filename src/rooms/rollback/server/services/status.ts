import { getAttempt, getTask, listAttemptStatesForTask, type LanePilotDatabase } from "../../../storage";
import type { RevertIntentKv } from "../../models";
import { getAttemptChange } from "../repositories/attempt-change-repository";
import { listTaskReceipts } from "../repositories/receipt-repository";
import { readRevertIntents } from "../repositories/revert-intent-repository";
import { recoveryState } from "./recovery";

export function createRollbackStatus(db: LanePilotDatabase, intentKv: () => RevertIntentKv) {
  function status(ref: string) {
    const attempt = getAttempt(db, ref);
    const taskId = attempt ? attempt.task_id : ref;
    const attempts = listAttemptStatesForTask(db, taskId)
      .map((row) => ({ ...row, change: getAttemptChange(db, row.id) ?? null, recovery: recoveryState(db, row.id) }));
    const receipts = listTaskReceipts(db, taskId);
    const reverted = [...receipts].reverse().find((row) => row.kind === "revert" && row.state === "merged");
    const mark = (reverted?.detail as { rollbackMark?: { cause?: string | null } } | undefined)?.rollbackMark;
    const rollback = reverted ? { commit: reverted.resultCommit, cause: mark?.cause ?? "rolled back, cause unknown" } : undefined;
    return { taskId, attempts, receipts, ...(rollback ? { rollback } : {}) };
  }

  async function pendingRevertIntent(ref: string) {
    const attempt = getAttempt(db, ref);
    const taskId = attempt ? attempt.task_id : ref;
    const task = getTask(db, taskId);
    const intent = task ? await readRevertIntents(intentKv(), task.run_id, taskId) : { state: "none" as const };
    if (intent.state === "pending") return { state: "pending" as const, opId: intent.intent.opId, expectedCommit: intent.intent.expectedCommit, createdAt: intent.intent.createdAt,
      next: "inspect the host checkout; dependency starts remain refused until this intent has positive Git proof" };
    if (intent.state === "unknown") return { state: "unknown" as const, reason: intent.reason, next: "repair/read Lane Pilot storage; dependency starts remain refused" };
    return undefined;
  }

  return { status, pendingRevertIntent };
}
