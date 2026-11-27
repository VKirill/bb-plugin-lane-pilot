import { TASK_OUTCOMES, taskOutcomeSchema, type TaskOutcome } from "@lane-pilot/contracts";
import { FAILED_ATTEMPT_STATES, isOpenAttemptState } from "./aggregation";

export { TASK_OUTCOMES, taskOutcomeSchema, type TaskOutcome };

const FAILED_STATES: ReadonlySet<string> = new Set(FAILED_ATTEMPT_STATES);

/**
 * Classifies a task's latest attempt state + attempt count into the owner-facing outcome vocabulary.
 * Returns null while the task is still in an open/non-terminal state.
 */
export function classifyOutcome(input: { finalState: string; attemptCount: number }): TaskOutcome | null {
  const { finalState, attemptCount } = input;
  if (isOpenAttemptState(finalState)) return null;
  if (finalState === "accepted" || finalState === "merged") {
    return attemptCount > 1 ? "reworked" : "accepted";
  }
  if (finalState === "canceled") return "canceled";
  if (FAILED_STATES.has(finalState)) return "failed";
  return null;
}
