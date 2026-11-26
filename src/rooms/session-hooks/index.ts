// Public API of session-hooks: the capsule a sticky writer restores after a compaction (src/rooms/writer/server/sticky.ts).
// cli.ts is the hook process itself, bundled by scripts/gen-session-hook.mjs; nothing imports it.
export { buildCapsule, capsuleRestored, sessionSummaryLine } from "./models";
export { conventionGateHits, type ConventionGate } from "./models";
export { STREAMS, type StreamName } from "./models";
export { GUARD_INVENTORY, guardInventoryGaps, type GuardRow } from "./models";
export { spentWindows, windowAppliesTo, SNAPSHOT_MAX_AGE_MS, type SpendWindow } from "./models";
