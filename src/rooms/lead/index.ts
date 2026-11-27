// Public API of lead («Штурман», the lead over the runs): migrations, task-word surface, settings, and road tree.
export { leadMigrations } from "./migrations";
export { answerTaskWord, askTaskWord, wordDecisionId } from "./server/services/surfaces";
export { taskWordItemPrefix } from "../contracts";
export {
  DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
  DEFAULT_PATHS_BRANCH_WINDOW_DAYS,
  DEFAULT_PATHS_DEDUPE_THRESHOLD,
  LEAD_DEFAULTS,
  LEAD_SETTING_KEYS,
  PATHS_BRANCH_DRAFT_REPEATS_KEY,
  PATHS_BRANCH_WINDOW_DAYS_KEY,
  PATHS_DEDUPE_THRESHOLD_KEY,
  leadSettingProblem,
  parseLeadSettings,
  type LeadSettingKey,
  type LeadSettings,
} from "./settings";
export { addRoad, doneRoad, getRoad, listRoad, reopenRoad } from "./server/repositories/road-repository";
export type { RoadEvidence, RoadRow } from "../contracts";
