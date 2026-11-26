// Public API of outage/server: the heartbeat, the outage repository, the command, and the room descriptor.
export { mountOutage } from "./handlers/outage-lifecycle";
export { OUTAGE_USAGE, runOutageCli } from "./handlers/outage-cli";
export { recordStartGap, stampBeat } from "./services/outage-service";
export { insertOutage, listOutages } from "./repositories/outage-repository";
export { room } from "./room";
