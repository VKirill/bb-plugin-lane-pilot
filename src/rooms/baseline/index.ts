// Public API of baseline: the migrations and the plain reads (storage and the acceptance card import them; the rest of the room is behind ./server so they never load it).
export { baselineMigrations } from "./migrations";
export { getBaseline, listBaselines, listRegressions } from "./store";
export type { BaselineRecord, RegressionRecord } from "./store";
export { EXISTENCE_ONLY_WORDS, NO_RED_KINDS, isExistenceOnly } from "./logic";
