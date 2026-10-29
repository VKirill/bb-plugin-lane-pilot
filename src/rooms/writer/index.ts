// Public API of writer: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { buildCliInvocation } from "./argv-builder";
export { attemptProduced, parseDirtSnapshots } from "./cli-outcome";
export type { DirtSnapshot } from "./cli-outcome";
export { runCommandOnHost, writePmSettingsOnHost } from "./cli-run";
export { materializeAgentTrash, ownedAgentTrashPath, AGENT_TRASH_RELATIVE } from "./agent-trash";
export { resolveStageWriterSelection } from "./stage-writer-selection";
export { attachStreamRetry, droppedStreamDetail } from "./stream-retry";
export { memoryLine, pathAnchors, reviewerMemoryPicks, writerBriefStats, writerMemory, writerMemoryPicks } from "./writer-brief";
export { writerFallbackChain, writerFallbackKeys, writerFallbacks } from "./writer-fallbacks";
export { writerReuseStats } from "./writer-reuse-stats";
