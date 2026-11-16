import type { LanePilotDatabase } from "../database";

/** Latest blocked attempts of unclosed runs: owner-judgment and parked live-folder work can resume and retain their files. */
export function listLatestBlockedAttemptRefs(db:LanePilotDatabase): Array<{
  id:string; run_id:string; task_id:string; workspace_path:string|null; workspace_decision_json:string|null;
}> {
  return db.prepare(`SELECT a.id,a.run_id,a.task_id,a.workspace_path,a.workspace_decision_json
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.state='blocked' AND r.closed_at IS NULL
      AND a.created_at=(SELECT MAX(b.created_at) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)`).all() as Array<{
        id:string; run_id:string; task_id:string; workspace_path:string|null; workspace_decision_json:string|null;
      }>;
}
