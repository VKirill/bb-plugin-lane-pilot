// Public API of wall: the migrations only (storage imports them; the rest of the room is behind ./server so storage never loads it).
export { listWalls, type WallRow } from "./store";
export { listClasses } from "./journal";
export type { WallClass } from "./types";
export { wallMigrations } from "./migrations";
