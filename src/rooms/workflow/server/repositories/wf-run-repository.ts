import { wfRunMetaByIds, type WfRunMetaRow } from "@lane-pilot/workflow-engine";
import type { LanePilotDatabase } from "../../../storage";

export type { WfRunMetaRow };

/** Reads `workflow_id` and raw `inputs_json` for a batch of workflow run ids. */
export function readWfRunMetaByIds(
  db: LanePilotDatabase,
  runIds: readonly string[],
): Map<string, WfRunMetaRow> {
  return wfRunMetaByIds(db as never, runIds);
}
