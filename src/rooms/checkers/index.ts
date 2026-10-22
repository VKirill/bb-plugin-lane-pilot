// Public API of checkers: the migrations only (storage imports them; the rest of the room is behind ./server so storage never loads it).
export { checkerMigrations } from "./migrations";
