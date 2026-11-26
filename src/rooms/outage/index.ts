// Public API of outage: the migrations, the gap rule, the report line and the read.
export { outageMigrations } from "./migrations";
export { BEAT_KEY, gapOutage, OUTAGE_THRESHOLD_MS } from "./models/outage";
export type { Outage, OutageRecord } from "./models/outage";
export { listOutages } from "./server/repositories/outage-repository";
