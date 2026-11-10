import type Database from "better-sqlite3";
import { taskV2Schema } from "../../contracts";
import { attemptMetrics } from "../../usage";
import { latestAcceptedAttemptRef, listForecastTaskRows } from "../../storage";
import { attemptChangeJson } from "../../rollback/server";
import { calibrate, calibrationBadge, scoreForecast, type Calibration, type CalibrationBadge, type ForecastFact, type ForecastScore } from "../logic";
import { listStageReceipts, loadPrototypeConfig } from "../../storage";

/**
 * The estimate-versus-fact report (SMA D2-1) from what is already on record: the forecast in the task's contract, the accepted attempt
 * (its number says whether it was the first), the files it changed (`lane_pilot_attempt_change`) and its tokens and time (attempt
 * metrics, `not_measured` stays null). A task with a forecast that is not accepted yet, or whose changes were not recorded, is counted
 * as waiting, never scored.
 */
export type ForecastRow = { runId: string; taskId: string; projectId: string; area: string | null; model: string | null; score: ForecastScore };
export type ForecastReport = { days: number; since: number; scored: ForecastRow[]; waiting: number; calibration: { overall: Calibration | null; byArea: Calibration[] };
/** The skeptic's countersigns scored beside the PM's (SMA k_v_skeptic): null when no plan critique carried one. */
skeptic: { overall: Calibration | null; rightAgainstPm: string[] } | null };

const DAY_MS = 86_400_000;

export function forecastReport(db: Database.Database, input: { projectId?: string | undefined; days?: number | undefined; now?: number | undefined } = {}): ForecastReport {
  const days = input.days ?? 30, now = input.now ?? Date.now(), since = now - days * DAY_MS;
  const tasks = listForecastTaskRows(db, { sinceMs: since, projectId: input.projectId });
  const scored: ForecastRow[] = [];
  const skepticRows: Array<{ area: string | null; score: ForecastScore }> = [];
  const rightAgainstPm: string[] = [];
  let waiting = 0;
  for (const row of tasks) {
    const parsed = taskV2Schema.safeParse(JSON.parse(row.contract_json));
    if (!parsed.success || !parsed.data.forecast) continue;
    const attempt = latestAcceptedAttemptRef(db, row.run_id, row.task_id);
    const changedJson = attempt ? attemptChangeJson(db, attempt.id) : undefined;
    const changed = changedJson === undefined ? undefined : { changed_json: changedJson };
    if (!attempt || !changed) { waiting += 1; continue; }
    const metrics = attemptMetrics(db, { projectId: row.project_id, days: days + 1, now, taskId: row.task_id }).attempts;
    const measured = metrics.filter((item) => item.tokens !== null);
    const changedFiles = JSON.parse(changed.changed_json) as Array<{ path?: unknown }>;
    // The accepted writer receipt keeps the measured size and the dependencies the merge's diff added (SMA k_lib_footprint).
    const writerReceipt = listStageReceipts(db, row.run_id, row.task_id).find((stage) => stage.stageId === "writer-agent")?.result as
      { size?: { lines?: unknown }; dependencies?: unknown } | null;
    const fact: ForecastFact = {
      files: changedFiles.length,
      firstTry: attempt.attempt_no === 1,
      tokens: measured.length === metrics.length && metrics.length ? measured.reduce((sum, item) => sum + item.tokens!.total, 0) : null,
      minutes: metrics.length && metrics.every((item) => item.seconds !== null) ? Math.round(metrics.reduce((sum, item) => sum + item.seconds!, 0) / 60) : null,
      lines: typeof writerReceipt?.size?.lines === "number" ? writerReceipt.size.lines : null,
      dependencies: Array.isArray(writerReceipt?.dependencies) ? writerReceipt.dependencies.filter((name): name is string => typeof name === "string") : [],
      changedPaths: changedFiles.flatMap((file) => typeof file.path === "string" ? [file.path] : []),
    };
    const score = scoreForecast(parsed.data.forecast, fact, (parsed.data.files ?? []).map((file) => file.path));
    scored.push({ runId: row.run_id, taskId: row.task_id, projectId: row.project_id, area: parsed.data.area ?? null, model: parsed.data.forecast.model ?? null, score });
    // The plan critic's countersign, when the receipt kept one, is scored on the same fact — a second opinion, not the PM's.
    const countersign = listStageReceipts(db, row.run_id, row.task_id).find((stage) => stage.stageId === "plan-critique")?.result;
    const cs = countersign && typeof countersign === "object" ? (countersign as { forecast_countersign?: { agree?: boolean; files?: number; checks_pass_first_try?: boolean } }).forecast_countersign : undefined;
    if (cs) {
      const skepticScore = scoreForecast({ files: cs.files ?? parsed.data.forecast.files, checks_pass_first_try: cs.checks_pass_first_try ?? parsed.data.forecast.checks_pass_first_try }, fact);
      skepticRows.push({ area: parsed.data.area ?? null, score: skepticScore });
      if (cs.agree === false && Math.abs(skepticScore.files.error) < Math.abs(score.files.error)) rightAgainstPm.push(row.task_id);
    }
  }
  const skeptic = skepticRows.length ? { overall: calibrate(skepticRows).overall, rightAgainstPm: rightAgainstPm } : null;
  return { days, since, scored, waiting, calibration: calibrate(scored), skeptic };
}

/**
 * The calibration passport (SMA k_v_passport): how far the forecasts of one model — the project's current PM model unless
 * `model` names another — can be trusted: its scored tasks, files MAE, first-try hit and the badge the owner reads.
 */
export type CalibrationPassport = { projectId: string; model: string | null; tasks: number; filesMae: number | null; firstTryHit: number | null; badge: CalibrationBadge };
export function calibrationPassport(db: Database.Database, projectId: string, model?: string | null): CalibrationPassport {
  const config = loadPrototypeConfig(db, projectId);
  const current = model ?? (config?.pmProviderId && config?.pmModel ? `${config.pmProviderId}/${config.pmModel}` : null);
  const overall = current ? calibrate(forecastReport(db, { projectId, days: 60 }).scored, current).overall : null;
  return { projectId, model: current, tasks: overall?.tasks ?? 0, filesMae: overall?.filesMae ?? null, firstTryHit: overall?.firstTryHit ?? null, badge: calibrationBadge(overall) };
}
