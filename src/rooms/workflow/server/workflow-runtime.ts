import type { LanePilotDatabase } from "../../storage";
import type { RunRow } from "../../storage";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";

/**
 * What the node executors of a chain run (agent, action, human, lp-task) need from the PM chat that started it. It is the
 * `runtime` of `engine.start`; after a reload the engine rebuilds it from the run row (`chainRuntimeFor`, workflow-executors.ts)
 * because the chat, the project and the Lane Pilot run are all in the row.
 */
export type ChainRuntime = {
  ctx: ServerCore; services: Services;
  /**
   * The PM chat that asked for the run: helper threads are its children and answers go to it. Null in a project that does not use
   * Lane Pilot: the helpers are then hidden threads of the project itself, the owner is asked through his list and the end is reported there.
   */
  pmThreadId: string | null;
  projectId: string;
  /** The Lane Pilot run (`lane_pilot_run`) of that chat: settings scopes, helper placement, budget. Null with no PM chat. */
  runId: string | null;
  /** `schedule` when a schedule started the run (the board, or a workflow's schedule trigger): the agents it starts cannot create schedules (schedule-tools.ts). */
  origin?: "schedule";
};

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
