import { tableExists, type OwnerItemSweep } from "../../owner-waiting";

const SCHEDULE_FAILURE_PREFIX = "schedule-failure:";

/** The owner-item key of a failed schedule run: `schedule-failure:<run>`. */
export const scheduleFailureItemKey = (runId: string) => `${SCHEDULE_FAILURE_PREFIX}${runId}`;

/** The schedule moved on: a later run ended (a failed one has its own row), the schedule is paused or gone (0.1.467). */
export const scheduleFailureSweep: OwnerItemSweep = (db, item) => {
  if (!item.key.startsWith(SCHEDULE_FAILURE_PREFIX) || item.kind !== "schedule_failed" || !tableExists(db, "lane_pilot_schedule_run")) return null;
  const run = db.prepare("SELECT schedule_id, finished_at FROM lane_pilot_schedule_run WHERE id=?").get(item.key.slice(SCHEDULE_FAILURE_PREFIX.length)) as { schedule_id: string; finished_at: number | null } | undefined;
  const schedule = run ? db.prepare("SELECT state FROM lane_pilot_schedule WHERE id=?").get(run.schedule_id) as { state: string } | undefined : undefined;
  if (!run || !schedule) return "janitor:schedule gone";
  if (schedule.state === "paused") return "janitor:schedule paused";
  if (db.prepare("SELECT 1 FROM lane_pilot_schedule_run WHERE schedule_id=? AND finished_at>? LIMIT 1").get(run.schedule_id, run.finished_at ?? 0)) return "janitor:a later run ended";
  return null;
};
