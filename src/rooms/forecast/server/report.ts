import type Database from "better-sqlite3";
import { taskV2Schema } from "../../contracts";
import { attemptMetrics } from "../../usage/server";
import { calibrate, scoreForecast, type Calibration, type ForecastFact, type ForecastScore } from "../logic";

/**
 * The estimate-versus-fact report (SMA D2-1) from what is already on record: the forecast in the task's contract, the accepted attempt
 * (its number says whether it was the first), the files it changed (`lane_pilot_attempt_change`) and its tokens and time (attempt
 * metrics, `not_measured` stays null). A task with a forecast that is not accepted yet, or whose changes were not recorded, is counted
 * as waiting, never scored.
 */
export type ForecastRow = { runId: string; taskId: string; projectId: string; area: string | null; score: ForecastScore };
export type ForecastReport = { days: number; since: number; scored: ForecastRow[]; waiting: number; calibration: { overall: Calibration | null; byArea: Calibration[] } };

const DAY_MS = 86_400_000;

export function forecastReport(db: Database.Database, input: { projectId?: string | undefined; days?: number | undefined; now?: number | undefined } = {}): ForecastReport {
  const days = input.days ?? 30, now = input.now ?? Date.now(), since = now - days * DAY_MS;
  const tasks = db.prepare(`SELECT t.id AS task_id, t.run_id, r.project_id, t.contract_json FROM lane_pilot_task t JOIN lane_pilot_run r ON r.id = t.run_id
    WHERE t.created_at >= ? AND t.contract_json LIKE '%"forecast"%' ${input.projectId ? "AND r.project_id = ?" : ""} ORDER BY t.created_at`)
    .all(since, ...(input.projectId ? [input.projectId] : [])) as Array<{ task_id: string; run_id: string; project_id: string; contract_json: string }>;
  const accepted = db.prepare("SELECT id, attempt_no FROM lane_pilot_attempt WHERE run_id = ? AND task_id = ? AND state = 'accepted' ORDER BY updated_at DESC LIMIT 1");
  const changes = db.prepare("SELECT changed_json FROM lane_pilot_attempt_change WHERE attempt_id = ?");
  const scored: ForecastRow[] = [];
  let waiting = 0;
  for (const row of tasks) {
    const parsed = taskV2Schema.safeParse(JSON.parse(row.contract_json));
    if (!parsed.success || !parsed.data.forecast) continue;
    const attempt = accepted.get(row.run_id, row.task_id) as { id: string; attempt_no: number } | undefined;
    const changed = attempt ? changes.get(attempt.id) as { changed_json: string } | undefined : undefined;
    if (!attempt || !changed) { waiting += 1; continue; }
    const metrics = attemptMetrics(db, { projectId: row.project_id, days: days + 1, now, taskId: row.task_id }).attempts;
    const measured = metrics.filter((item) => item.tokens !== null);
    const fact: ForecastFact = {
      files: (JSON.parse(changed.changed_json) as unknown[]).length,
      firstTry: attempt.attempt_no === 1,
      tokens: measured.length === metrics.length && metrics.length ? measured.reduce((sum, item) => sum + item.tokens!.total, 0) : null,
      minutes: metrics.length && metrics.every((item) => item.seconds !== null) ? Math.round(metrics.reduce((sum, item) => sum + item.seconds!, 0) / 60) : null,
    };
    scored.push({ runId: row.run_id, taskId: row.task_id, projectId: row.project_id, area: parsed.data.area ?? null, score: scoreForecast(parsed.data.forecast, fact) });
  }
  return { days, since, scored, waiting, calibration: calibrate(scored) };
}
