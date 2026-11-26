import {
  clearReconcileCursor,
  hasReconcileCursor,
  reconcileCursorPage,
  saveReconcileCursor,
  type LanePilotDatabase,
} from "../../../storage";
import type { ReconcileCursor } from "../../models/reconcile";

/** One row per attempt and scan kind (`writer` or `holder`). `read` is null until the first page is saved. */
export function reconcileCursor(db: LanePilotDatabase, attemptId: string, kind: "writer" | "holder"): ReconcileCursor {
  const scanKey = `${kind}:${attemptId}`;
  return {
    read() { return reconcileCursorPage(db, scanKey) ?? null; },
    save(page: number) { saveReconcileCursor(db, scanKey, attemptId, page, Date.now()); },
    clear() { clearReconcileCursor(db, scanKey); },
  };
}

/** Whether a reconcile scan is still in flight for the attempt (its cursor is saved mid-page). */
export function reconcileScanOpen(db: LanePilotDatabase, attemptId: string): boolean {
  return hasReconcileCursor(db, attemptId);
}
