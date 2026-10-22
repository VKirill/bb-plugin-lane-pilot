// Public API of run-goal: the migrations, the pure decisions and the stored verdict (the checking service is behind ./server).
export { runGoalMigrations } from "./migrations";
export { goalVerdict, pmGoalMessage, runReady, MIN_ACCEPTED } from "./logic";
export type { GoalVerdict, RedCheck, TaskState } from "./logic";
export { getRunGoal } from "./store";
export type { RunGoalRecord } from "./store";
