import type { ServerCore } from "../../../contracts/server";

export type AttemptLivenessRow = { state: string; updated_at: number; area: string | null };

const ATTEMPT_LIVENESS_SQL = `SELECT a.state, a.updated_at, json_extract(t.contract_json,'$.area') AS area
  FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
  LEFT JOIN lane_pilot_task t ON t.id=a.task_id AND t.run_id=a.run_id`;

/** Reads liveness rows for the attempt that created a worktree row or any attempt currently using that workspace on the host. */
export function listAttemptLivenessForWorktree(
  db: ServerCore["db"],
  ownerId: string | null,
  path: string,
  host: string,
): AttemptLivenessRow[] {
  return db.prepare(`${ATTEMPT_LIVENESS_SQL}
    WHERE a.id=? OR (a.workspace_path=? AND r.writer_host_id=?)`).all(ownerId, path, host) as AttemptLivenessRow[];
}
