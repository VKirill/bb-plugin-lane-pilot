import type { MemoryDatabase } from "./store";

/** A session or an import is one voice: its notes wait this long for a second source before a writer reads them. */
export const OBSERVED_QUARANTINE_MS = 24 * 3_600_000;

/** Hides a record (it stays in the table, leaves every index) with the status that says why. */
export function hideRecord(db: MemoryDatabase, projectId: string, id: string, status: "superseded" | "expired", supersededBy: string | null, unindex: (projectId: string, id: string) => void): boolean {
  const changed = db.prepare("UPDATE lane_pilot_memory SET status=?, superseded_by=COALESCE(?,superseded_by) WHERE project_id=? AND id=? AND status='active'").run(status, supersededBy, projectId, id).changes === 1;
  if (changed) unindex(projectId, id);
  return changed;
}
