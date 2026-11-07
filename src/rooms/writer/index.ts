// Public API of writer: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { buildCliInvocation } from "./argv-builder";
export { attemptProduced, parseDirtSnapshots } from "./cli-outcome";
export type { DirtSnapshot } from "./cli-outcome";
export { runCommandOnHost, writePmSettingsOnHost } from "./cli-run";
export { materializeAgentTrash, ownedAgentTrashPath, AGENT_TRASH_RELATIVE } from "./agent-trash";
export { resolveStageWriterSelection } from "../platform/server";
export { attachStreamRetry, droppedStreamDetail } from "./stream-retry";
export { writerBriefStats } from "./writer-brief";
export { WRITER_FINISH_SCAN_ID, writerFinishScanJudgment, type FinishScanDecision, type FinishScanInput } from "./finish-scan";
export { WRITER_FALLBACK_DEFAULTS, WRITER_FALLBACK_SLOTS, writerFallbackChain, writerFallbackKeys, writerFallbackSeed, writerFallbackSlots, writerFallbacks } from "../platform/server";
export type { WriterFallback, WriterFallbackSlot } from "../platform/server";
export { BEST_OF_COUNT, BEST_OF_ROUNDS_DEFAULT, BEST_OF_ROUNDS_MAX, BEST_OF_ROUNDS_SETTING, BEST_OF_SETTING, BEST_OF_SLOT_CAP_SETTING, BEST_OF_TOKEN_BUDGET_SETTING, BEST_OF_VALUES, ROUND_SEED_MAX_CHARS, bestOfBudgetAllows, bestOfPicks, pickBestAttempt, reserveAppetite, resolveBestOf, roundSeedBrief, roundSurvivors } from "./best-of";
export type { RoundCandidate } from "./best-of";
export type { BestOfCandidate, BestOfPlan, WriterPair } from "./best-of";
export { writerReuseStats } from "./writer-reuse-stats";
export { writerModelJudgment } from "./writer-model-pick";
export {
  calculateSkillSwitches,
  extractSkillSequence,
  getSkillSwitchStats,
  recordSkillSwitchMetric,
  skillSwitchMorningLine,
  type SkillSwitchRecord,
  type SkillSwitchStats,
} from "./skill-switch";
export { STICKY_WINDOW_MS } from "../platform/server";
export { LIVE_FOLDER_FILE_CAP } from "./live-folder";
