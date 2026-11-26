// Public API of baseline: the migrations and the plain reads (storage and the acceptance card import them; the rest of the room is behind ./server so they never load it).
export { baselineMigrations } from "./migrations";
export { getBaseline, listBaselines, taskBaselineEntries } from "./server/repositories/baseline-repository";
export type { BaselineRecord } from "./server/repositories/baseline-repository";
export { isExistenceOnly } from "./models/logic";
