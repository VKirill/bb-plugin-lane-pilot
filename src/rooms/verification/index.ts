// Public API of verification: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { gateTriagePrompt, parseGateTriageResult } from "./gate-triage";
export { sweepLaneWorktrees, JANITOR_TMP_PREFIXES } from "./worktree-janitor";
export type { JanitorKept, JanitorReceipt } from "./worktree-janitor";
export { appendExcludeCommand, createWorktree, ensureExcludeLinesCommand, EXCLUDE_NOT_GIT, integrateWorktree, persistTaskFolder, prepareWorktree, removeLaneWorktree, revertPaths, snapshotWorktree, syncWorktree, taskFolderRel, withBaseLock } from "./git-integrate";
export type { ReplayCheck, ReplayCheckOutcome } from "./git-integrate";
export { gitOwnershipChangedPaths, resolveGitOwnershipBase, undoCheckWrites } from "./git-ownership";
export { attributeGateOnHost, bisectGateOnHost, runGateOnHost } from "./integration-gate-host";
export { darwinAvailableBytes, readMachineFacts } from "./machine-reading";
export type { HostMachineFacts } from "./machine-reading";
export { createProviderGate, providerListed, providerSwitchOn, waitProviderEnvironment } from "./provider-gate";
export { parseWorkspaceMode, requireManagedWorktreeProvider, resolveAttemptWorkspace, resolveManagedWorkspace, usesManagedWorktree, waitManagedWorktreeReady } from "./routing";
export { prepareSandboxedCommandLine, releaseSandboxedCommandLine, runSandboxedCommandOnHost, userToolBins } from "./sandbox";
export { WORKSPACE_DIRT_COMMAND } from "./workspace-dirt";
export { mergeInfo, revertCommitsInWorktree, worktreeState } from "./git-rollback";
export { MERGE_INTENT_PREFIX } from "./server/merge-intent";
export type { MergeInfo, RevertResult, WorktreeState } from "./git-rollback";
export { TEST_FILE_RE, suggestTests, testHintLine } from "./test-hint";
export { cachedReplayVerdicts, recordedReplayFailure, recordReplayVerdict, replayCacheLocation, replayKey } from "./replay-cache";
export type { ReplayCacheEntry } from "./replay-cache";
export { PRESSURE_LIMITS, flakyEvidence, outputTail, pressureOf, readingFrom, readingNote } from "./machine-pressure";
export { DEFAULT_WORKER, WORKER_SECRET_PATHS, workerSecretReach } from "./worker-user";
