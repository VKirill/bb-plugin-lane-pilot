// Public API of stage-return: the migrations and the plain reads (storage, the writer's brief and the acceptance card import them; the rest of the room is behind ./server).
export { stageReturnMigrations } from "./migrations";
export { getReturn, listReturns } from "./store";
export type { StageReturnRecord } from "./store";
export { renderReturnNotes } from "./logic";
