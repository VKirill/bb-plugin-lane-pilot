import { laneSetup } from "./v2.ts"

export { laneSetup } from "./v2.ts"
export { LANE_AGENT_PREFIX, agentDenies, hubShellDenial, isLaneAgent } from "./hub-guard.ts"
export { guardTool } from "./guard.ts"

export default { id: "opencode-lane", setup: laneSetup }
