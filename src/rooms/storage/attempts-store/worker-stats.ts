import { isOpenAttemptState } from "../../contracts/state-machine";
import type { LanePilotDatabase } from "../database";

const TRACE_WORKER = `COALESCE(json_extract(t.trace_json,'$.providerId'),'unknown') AS provider_id, COALESCE(json_extract(t.trace_json,'$.model'),'unknown') AS model`;
const asWorker = (row: { provider_id: unknown; model: unknown }) => ({ providerId: typeof row.provider_id === "string" ? row.provider_id : "unknown", model: typeof row.model === "string" ? row.model : "unknown" });

/** Done and not done per worker and day (SMA m_sw_worker_history): attempts of a project since a time, grouped by the
 * provider/model of their reasoning trace — an attempt without a trace counts under "unknown". `done` is accepted,
 * `notDone` is every ended state that is not (blocked, failed kinds, canceled); open attempts count in neither. */
export function workerOutcomesSince(db: LanePilotDatabase, projectId: string, sinceMs: number): Array<{ providerId: string; model: string; day: string; done: number; notDone: number }> {
  // json_extract on a broken trace raises; only a stored trace that is valid JSON is asked.
  const rows = db.prepare(`SELECT a.state, a.created_at, ${TRACE_WORKER} FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id LEFT JOIN lane_pilot_attempt_reasoning t ON t.attempt_id=a.id AND json_valid(t.trace_json)
    WHERE r.project_id=? AND a.created_at>=?`).all(projectId, sinceMs) as Array<{ state: string; created_at: number; provider_id: unknown; model: unknown }>;
  const out = new Map<string, { providerId: string; model: string; day: string; done: number; notDone: number }>();
  for (const row of rows) {
    const { providerId, model } = asWorker(row);
    const day = new Date(row.created_at).toISOString().slice(0, 10);
    const key = `${providerId}/${model}/${day}`;
    const cell = out.get(key) ?? { providerId, model, day, done: 0, notDone: 0 };
    if (row.state === "accepted") cell.done += 1;
    else if (!isOpenAttemptState(row.state)) cell.notDone += 1;
    out.set(key, cell);
  }
  return [...out.values()];
}

/** What each worker holds right now (SMA m_sw_worker_card): its open attempts with the task ids and the time of its
 * newest attempt, grouped by the trace's provider/model like workerOutcomesSince. */
export function workerPresenceNow(db: LanePilotDatabase, projectId: string, sinceMs: number): Array<{ providerId: string; model: string; running: number; taskIds: string[]; lastAt: number | null }> {
  const rows = db.prepare(`SELECT a.task_id, a.state, a.updated_at, ${TRACE_WORKER} FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id LEFT JOIN lane_pilot_attempt_reasoning t ON t.attempt_id=a.id AND json_valid(t.trace_json)
    WHERE r.project_id=? AND a.updated_at>=?`).all(projectId, sinceMs) as Array<{ task_id: string; state: string; updated_at: number; provider_id: unknown; model: unknown }>;
  const out = new Map<string, { providerId: string; model: string; running: number; taskIds: string[]; lastAt: number | null }>();
  for (const row of rows) {
    const { providerId, model } = asWorker(row);
    const key = `${providerId}/${model}`;
    const cell = out.get(key) ?? { providerId, model, running: 0, taskIds: [], lastAt: null };
    if (isOpenAttemptState(row.state)) { cell.running += 1; if (!cell.taskIds.includes(row.task_id)) cell.taskIds.push(row.task_id); }
    cell.lastAt = Math.max(cell.lastAt ?? 0, row.updated_at);
    out.set(key, cell);
  }
  return [...out.values()];
}
