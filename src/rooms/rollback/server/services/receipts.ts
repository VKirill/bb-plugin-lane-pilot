import type { RollbackResult, RollbackTarget, TaskReceipt, TaskReceiptKind, TaskReceiptState } from "../../models";
import { appendTaskReceipt } from "../repositories/receipt-repository";

export function createRollbackReceipts(db: Parameters<typeof appendTaskReceipt>[0], log: (line: string) => void) {
  function receipt(t: RollbackTarget, kind: TaskReceiptKind, state: TaskReceiptState, summary: string,
    extra: Partial<Pick<TaskReceipt, "attemptId" | "baseSha" | "changeSha" | "resultCommit">> & { detail?: unknown } = {}): number {
    try {
      return appendTaskReceipt(db, {
        kind,
        projectId: t.projectId,
        runId: t.runId,
        taskId: t.taskId,
        state,
        summary,
        attemptId: extra.attemptId ?? null,
        baseSha: extra.baseSha ?? null,
        changeSha: extra.changeSha ?? null,
        resultCommit: extra.resultCommit ?? null,
        detail: extra.detail ?? {},
      });
    } catch (cause) { log(`rollback receipt not kept: ${cause instanceof Error ? cause.message : String(cause)}`); return 0; }
  }

  const refuse = (t: RollbackTarget | null, kind: TaskReceiptKind, ref: string, reason: string, next: string,
    extra: { attemptId?: string | null; detail?: unknown } = {}): RollbackResult => {
    const taskId = t?.taskId ?? ref;
    const receiptId = t ? receipt(t, kind, "refused", reason, { attemptId: extra.attemptId ?? null, detail: { next, ...(extra.detail as object | undefined) } }) : 0;
    return { ok: false, state: "refused", taskId, attemptId: extra.attemptId ?? null, base: null, change: null, summary: reason, next, ...(receiptId ? { receiptId } : {}), ...(extra.detail as object | undefined) };
  };
  return { receipt, refuse };
}
