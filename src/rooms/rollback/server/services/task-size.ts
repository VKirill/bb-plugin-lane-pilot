import type { TaskSizeMedian } from "../../../tasks";
import { computeMedianTaskSize } from "../../models";
import { acceptedAttemptSizeRows, type RollbackDb } from "../repositories/attempt-change-repository";

/**
 * The median accepted-task size of the project, from `lane_pilot_attempt` joins `lane_pilot_attempt_change`
 * (accepted attempts only, finished last). Null under TASK_SIZE_MIN_SAMPLE: too few accepted tasks to judge a grain.
 */
export function medianTaskSize(db: RollbackDb, projectId: string): TaskSizeMedian | null {
  return computeMedianTaskSize(acceptedAttemptSizeRows(db, projectId));
}
