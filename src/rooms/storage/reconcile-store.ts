// The reconcile scanner's resume cursor (lane_pilot_reconcile_cursor): attempt liveness bookkeeping that
// storage's own listOpenAttempts reads, so the table's functions live here with its schema.
import type { LanePilotDatabase } from "./database";

/** The page an interrupted scan reached; absent when no scan is mid-flight. */
export function reconcileCursorPage(db: LanePilotDatabase, scanKey: string): number | undefined {
  return (db.prepare("SELECT page FROM lane_pilot_reconcile_cursor WHERE scan_key=?").get(scanKey) as { page: number } | undefined)?.page;
}

/** Save where the scan got to (the next process continues the page). */
export function saveReconcileCursor(db: LanePilotDatabase, scanKey: string, attemptId: string, page: number, at: number): void {
  db.prepare(`INSERT INTO lane_pilot_reconcile_cursor(scan_key, attempt_id, page, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(scan_key) DO UPDATE SET page=excluded.page, updated_at=excluded.updated_at`).run(scanKey, attemptId, page, at);
}

/** The scan finished or gave up: nothing to resume. */
export function clearReconcileCursor(db: LanePilotDatabase, scanKey: string): void {
  db.prepare("DELETE FROM lane_pilot_reconcile_cursor WHERE scan_key=?").run(scanKey);
}

/** Whether the attempt has a saved scan page (it is still in flight). */
export function hasReconcileCursor(db: LanePilotDatabase, attemptId: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS n FROM lane_pilot_reconcile_cursor WHERE attempt_id=? LIMIT 1").get(attemptId));
}
