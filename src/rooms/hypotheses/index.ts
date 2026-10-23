// Public API of hypotheses: the migrations, the arms of a hypothesis, the seeded ones and the writer's brief mode.
export { hypothesisMigrations } from "./migrations";
export { armsOf, SEEDED, settingsPair } from "./logic";
export type { HypothesisState } from "./logic";
export { briefMode, briefParts } from "./brief-mode";
export type { BriefMode } from "./brief-mode";
