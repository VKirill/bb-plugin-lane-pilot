import type { LanePilotDatabase } from "../../storage";
import type { RunRow } from "../../storage";
import type { ServerCore } from "../../contracts/server";



/** The idempotency key prefix of a run a schedule started; the origin is read back from it (and from the parent run) after a reload. */
export const SCHEDULE_RUN_KEY_PREFIX = "wf-schedule:";

/** Whether a schedule started the run, or the run it is a subworkflow of (a few levels up). */
export function startedBySchedule(db: LanePilotDatabase, run: Pick<RunRow, "idem_key" | "parent_run_id">): boolean {
  let current: Pick<RunRow, "idem_key" | "parent_run_id"> | undefined = run;
  for (let hop = 0; current && hop < 8; hop += 1) {
    if (current.idem_key?.startsWith(SCHEDULE_RUN_KEY_PREFIX)) return true;
    current = current.parent_run_id
      ? db.prepare("SELECT idem_key, parent_run_id FROM lane_pilot_wf_run WHERE id=?").get(current.parent_run_id) as Pick<RunRow, "idem_key" | "parent_run_id"> | undefined
      : undefined;
  }
  return false;
}
