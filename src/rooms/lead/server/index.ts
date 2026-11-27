// Public API of lead/server: the road, nearest-unit ladder, tick actions, path discovery, and task-word surface.
export { acceptRoad, addRoad, doneRoad, findRoadByPayloadKey, getRoad, laterRoad, listRoad, proposeRoad, rejectRoad, reopenRoad } from "./repositories/road-repository";
export { taskWordPort } from "./services/surfaces";
export { attachNearest, formHypothesis, graphSignalsOf, nearestUnits } from "./services/nearest";
export { listPathCandidates, type Candidate, type ListPathCandidatesInput, type PathCandidatesLog } from "./services/path-candidates";
export { registerLeadTickActions } from "./handlers/tick-actions";
export {
  DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
  DEFAULT_PATHS_BRANCH_WINDOW_DAYS,
  DEFAULT_PATHS_DEDUPE_THRESHOLD,
  PATHS_BRANCH_DRAFT_REPEATS_KEY,
  PATHS_BRANCH_WINDOW_DAYS_KEY,
  PATHS_DEDUPE_THRESHOLD_KEY,
  parseLeadSettings,
} from "../settings";
export { OWNER_ITEM_SWEEPS } from "./services/sweeps";
export { mountLeadTool } from "./handlers/lead-tool";
export { room } from "./room";
