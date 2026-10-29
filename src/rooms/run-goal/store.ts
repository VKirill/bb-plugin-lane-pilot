import type Database from "better-sqlite3";
import type { GoalCoverage, GoalVerdict, RedCheck } from "./logic";

type Db = Pick<Database.Database, "prepare">;
export type RunGoalRecord = {
  runId: string; projectId: string; state: GoalVerdict["state"]; tasks: number; headSha: string | null; red: RedCheck[]; detail: string | null; at: number;
  coverage: GoalCoverage;
};

export function saveRunGoal(db: Db, row: RunGoalRecord): void {
  db.prepare(`INSERT INTO lane_pilot_run_goal(run_id,project_id,state,tasks,head_sha,red_json,detail,at,planned,ran,skipped_checks) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET state=excluded.state, tasks=excluded.tasks, head_sha=excluded.head_sha, red_json=excluded.red_json, detail=excluded.detail, at=excluded.at,
      planned=excluded.planned, ran=excluded.ran, skipped_checks=excluded.skipped_checks`)
    .run(row.runId, row.projectId, row.state, row.tasks, row.headSha, JSON.stringify(row.red), row.detail, row.at, row.coverage.planned, row.coverage.ran, row.coverage.skipped);
}

export function getRunGoal(db: Db, runId: string): RunGoalRecord | null {
  const row = db.prepare("SELECT * FROM lane_pilot_run_goal WHERE run_id=?").get(runId) as
    { run_id: string; project_id: string; state: GoalVerdict["state"]; tasks: number; head_sha: string | null; red_json: string; detail: string | null; at: number; planned: number; ran: number; skipped_checks: number } | undefined;
  return row ? { runId: row.run_id, projectId: row.project_id, state: row.state, tasks: row.tasks, headSha: row.head_sha, red: JSON.parse(row.red_json) as RedCheck[], detail: row.detail, at: row.at, coverage: { planned: row.planned, ran: row.ran, skipped: row.skipped_checks } } : null;
}
