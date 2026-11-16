import type Database from "better-sqlite3";

/** Includes interrupted/blocked children: their callers can resume them after the current turn. */
export function wfHasResumableLinkedRun(db: Pick<Database.Database, "prepare">, linkRunId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE link_run_id=? AND status IN ('running','waiting','blocked','interrupted') LIMIT 1").get(linkRunId));
}
