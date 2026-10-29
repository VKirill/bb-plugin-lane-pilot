// Public API of run-goal: the migrations, the pure decisions and the stored verdict (the checking service is behind ./server).
export { runGoalCoverageMigrations, runGoalMigrations } from "./migrations";
export { goalCoverage, goalVerdict, pmGoalMessage, runReady, MIN_ACCEPTED } from "./logic";
export type { GoalCoverage, GoalVerdict, RedCheck, TaskState } from "./logic";
export { getRunGoal } from "./store";
export type { RunGoalRecord } from "./store";
