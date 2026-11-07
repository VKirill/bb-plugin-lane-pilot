// Public API of baseline: the migrations and the plain reads (storage and the acceptance card import them; the rest of the room is behind ./server so they never load it).
export { baselineMigrations } from "./migrations";
export { getBaseline, listBaselines, listRegressions, taskBaselineEntries, openRegressionBriefs } from "./store";
export { commandPathLiterals, quarantineFilesOf, quarantineFileSet } from "./regress-files";
export type { BaselineRecord, RegressionRecord } from "./store";
export { isExistenceOnly } from "./logic";
