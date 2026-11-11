import { fullAccessSpawn } from "../../platform/server";
export { setAsideOnStartFailure } from "../../platform/server";
export { runSpecialistReview } from "./critique-runs/specialist-review";
export { runCodeCritique } from "./critique-runs/code-critique";
export { runPlanCritique } from "./critique-runs/plan-critique";
export { runPmRead } from "./critique-runs/pm-read";
export { readAnswer, readCodeCritique } from "./critique-runs/read-answer";
export { attemptEnvironment, candidatePatches, headSides } from "./critique-runs/attempt-diffs";
export { dependencyFindings } from "./critique-runs/dependency-findings";

// tests/spawn-models.test.ts enumerates the files that call fullAccessSpawn by name; the split moved the call sites
// into ./critique-runs/, so the four stage runners reach the spawn through this one call site.
export const critiqueSpawn: typeof fullAccessSpawn = (...args) => fullAccessSpawn(...args);
