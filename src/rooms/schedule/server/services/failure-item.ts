import { tableExists, type OwnerItemSweep } from "../../../owner-waiting";
import { failureRunState } from "../repositories/schedule-repository";

const SCHEDULE_FAILURE_PREFIX = "schedule-failure:";

/** The owner-item key of a failed schedule run: `schedule-failure:<run>`. */
export const scheduleFailureItemKey = (runId: string) => `${SCHEDULE_FAILURE_PREFIX}${runId}`;

/** The schedule moved on: a later run ended (a failed one has its own row), the schedule is paused or gone (0.1.467). */
export const scheduleFailureSweep: OwnerItemSweep = (db, item) => {
  if (!item.key.startsWith(SCHEDULE_FAILURE_PREFIX) || item.kind !== "schedule_failed" || !tableExists(db, "lane_pilot_schedule_run")) return null;
  const { run, schedule, hasLaterRun } = failureRunState(db, item.key.slice(SCHEDULE_FAILURE_PREFIX.length));
  if (!run || !schedule) return "janitor:schedule gone";
  if (schedule.state === "paused") return "janitor:schedule paused";
  if (hasLaterRun) return "janitor:a later run ended";
  return null;
};
