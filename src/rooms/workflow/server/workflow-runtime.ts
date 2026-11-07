import type { LanePilotDatabase } from "../../storage";
import { wfRunIdemParent } from "@lane-pilot/workflow-engine";
import type { RunRow } from "../../storage";
import type { ServerCore } from "../../contracts/server";
import { SCHEDULE_RUN_KEY_PREFIX } from "../../contracts";

/** Whether a schedule started the run, or the run it is a subworkflow of (a few levels up). */
export function startedBySchedule(db: LanePilotDatabase, run: Pick<RunRow, "idem_key" | "parent_run_id">): boolean {
  let current: Pick<RunRow, "idem_key" | "parent_run_id"> | undefined = run;
  for (let hop = 0; current && hop < 8; hop += 1) {
    if (current.idem_key?.startsWith(SCHEDULE_RUN_KEY_PREFIX)) return true;
    current = current.parent_run_id
      ? wfRunIdemParent(db, current.parent_run_id) as Pick<RunRow, "idem_key" | "parent_run_id"> | undefined
      : undefined;
  }
  return false;
}
