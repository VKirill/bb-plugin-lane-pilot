// Public API of lead/server: the service and its mount (server.ts), the RPC (core/server/rpc.ts), the tool (tools room), the CLI (tools mount it).
// The journal and the backtest stay private; the surfaces are on the room's index.
export { LEAD_USAGE, runLeadCli } from "../cli";
export { leadRpc } from "./rpc";
export { addRoad, doneRoad, getRoad, listRoad, reopenRoad } from "./road";
export { taskWordPort } from "./surfaces";
export { createLeadService, LEAD_EXAM_CRON, LEAD_SWEEP_CRON, mountLead, type LeadApi, type LeadState } from "./service";
export { mountLeadTool } from "./tool";
