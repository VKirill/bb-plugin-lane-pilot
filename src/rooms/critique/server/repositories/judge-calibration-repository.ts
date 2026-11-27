import type { LanePilotDatabase } from "../../../storage";

export type JudgeCalibrationRow = {
  workflowId: string;
  judgeProvider: string;
  judgeModel: string;
  n: number;
  agree: number;
  wilsonLow: number;
  trusted: boolean;
  at: number;
};

export function upsertJudgeCalibration(db: LanePilotDatabase, row: JudgeCalibrationRow): void {
  db.prepare(
    `INSERT INTO lane_pilot_judge_calibration
      (workflow_id, judge_provider, judge_model, n, agree, wilson_low, trusted, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workflow_id, judge_provider, judge_model) DO UPDATE SET
       n = excluded.n,
       agree = excluded.agree,
       wilson_low = excluded.wilson_low,
       trusted = excluded.trusted,
       at = excluded.at`,
  ).run(
    row.workflowId,
    row.judgeProvider,
    row.judgeModel,
    row.n,
    row.agree,
    row.wilsonLow,
    row.trusted ? 1 : 0,
    row.at,
  );
}

export function getJudgeCalibration(
  db: LanePilotDatabase,
  workflowId: string,
  judge: { provider: string; model: string },
): JudgeCalibrationRow | null {
  const row = db.prepare(
    `SELECT workflow_id, judge_provider, judge_model, n, agree, wilson_low, trusted, at
     FROM lane_pilot_judge_calibration
     WHERE workflow_id = ? AND judge_provider = ? AND judge_model = ?`,
  ).get(workflowId, judge.provider, judge.model) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    workflowId: String(row.workflow_id),
    judgeProvider: String(row.judge_provider),
    judgeModel: String(row.judge_model),
    n: Number(row.n),
    agree: Number(row.agree),
    wilsonLow: Number(row.wilson_low),
    trusted: Number(row.trusted) === 1,
    at: Number(row.at),
  };
}

export function readJudgeTrusted(
  db: LanePilotDatabase,
  workflowId: string,
  judge: { provider: string; model: string },
): boolean {
  const row = db.prepare(
    `SELECT trusted
     FROM lane_pilot_judge_calibration
     WHERE workflow_id = ? AND judge_provider = ? AND judge_model = ?`,
  ).get(workflowId, judge.provider, judge.model) as { trusted?: unknown } | undefined;
  return Boolean(row && Number(row.trusted) === 1);
}
