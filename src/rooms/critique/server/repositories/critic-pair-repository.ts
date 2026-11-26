import { getReasoningTrace, listAttemptsForTask, type LanePilotDatabase } from "../../../storage";
import type { Pair } from "../../models/critic-pair";

/** The pair of the task's latest attempt that has a reasoning trace (the writer that produced the work), or null. */
export function latestWriterPair(db: LanePilotDatabase, runId: string, taskId: string): Pair | null {
  for (const attempt of [...listAttemptsForTask(db, runId, taskId)].reverse()) {
    const trace = getReasoningTrace(db, attempt.id);
    if (trace?.providerId && trace.model) return { providerId: trace.providerId, model: trace.model };
  }
  return null;
}
