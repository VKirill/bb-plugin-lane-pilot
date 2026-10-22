// Public API of outage: the migrations, the gap rule, the report line and the read.
export { outageMigrations } from "./migrations";
export { BEAT_KEY, gapOutage, OUTAGE_THRESHOLD_MS } from "./logic";
export type { Outage } from "./logic";
export { listOutages } from "./store";
export type { OutageRecord } from "./store";
