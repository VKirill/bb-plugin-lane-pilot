// Public API of outbound: the task event webhook (its nine fields, the decision when to send) and its service.
export { EVENT_FIELDS, taskEventBody, isOutboundState, mountOutbound, worldVersion } from "./outbound";
export type { TaskEvent } from "./outbound";
