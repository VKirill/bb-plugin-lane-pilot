// Public API of bench: the migrations only (storage imports them; the rest of the room is behind ./server so storage never loads it).
export { benchMigrations } from "./migrations";
// The two reads other rooms make: which tree a bench project runs under, and the bench's word on a harness tree (store.ts imports nothing heavy).
export { getBenchProject, saveVerdict, verdictForHarness } from "./store";
export type { BenchProjectControl } from "./store";
