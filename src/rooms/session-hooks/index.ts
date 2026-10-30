// Public API of session-hooks: the capsule a sticky writer restores after a compaction (src/rooms/writer/server/sticky.ts).
// cli.ts is the hook process itself, bundled by scripts/gen-session-hook.mjs; nothing imports it.
export { buildCapsule, capsuleRestored } from "./logic";
