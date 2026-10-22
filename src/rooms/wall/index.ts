// Public API of wall: the migrations only (storage imports them; the rest of the room is behind ./server so storage never loads it).
export { wallDeferralKindMigrations, wallMigrations } from "./migrations";
