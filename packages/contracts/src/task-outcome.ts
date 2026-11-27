import { z } from "zod";

/** Closed outcome vocabulary for finished tasks in Task History and Overview. The classifier lives in src/rooms/runs/models/task-outcome.ts. */
export const TASK_OUTCOMES = ["accepted", "reworked", "canceled", "failed"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];
export const taskOutcomeSchema = z.enum(TASK_OUTCOMES);
