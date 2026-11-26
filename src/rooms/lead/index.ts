// Public API of lead («Штурман», the lead over the runs): migrations, task-word surface, settings, and road tree.
export { leadMigrations } from "./migrations";
export { answerTaskWord, askTaskWord, wordDecisionId } from "./server/services/surfaces";
export { taskWordItemPrefix } from "../contracts";
export { LEAD_DEFAULTS, LEAD_SETTING_KEYS, leadSettingProblem, parseLeadSettings, type LeadSettingKey, type LeadSettings } from "./settings";
export { addRoad, doneRoad, getRoad, listRoad, reopenRoad } from "./server/repositories/road-repository";
export type { RoadEvidence, RoadRow } from "../contracts";
