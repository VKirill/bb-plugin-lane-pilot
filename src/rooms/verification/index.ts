// Public API of verification: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { buildDocsFlows } from "./docs-flows";
export { buildDocsAnchors, docsDepth, docsStaleness, jevApiKey, provideJevKey, jevProviderOfKey, verifyDocsCitations } from "./docs-jev";
export { gateTriagePrompt, parseGateTriageResult } from "./gate-triage";
export { commitDocs, docsLineCounts, docsWorthinessFacts, gitDocsScope, revertPaths } from "./git-docs";
export { appendExcludeCommand, createWorktree, ensureExcludeLinesCommand, EXCLUDE_NOT_GIT, integrateWorktree, persistTaskFolder, prepareWorktree, removeLaneWorktree, snapshotWorktree, syncWorktree, taskFolderRel } from "./git-integrate";
export type { ReplayCheckOutcome } from "./git-integrate";
export { gitOwnershipChangedPaths, resolveGitOwnershipBase, undoCheckWrites } from "./git-ownership";
export { attributeGateOnHost, bisectGateOnHost, runGateOnHost } from "./integration-gate-host";
export { darwinAvailableBytes, readMachineFacts } from "./machine-reading";
export type { HostMachineFacts } from "./machine-reading";
export { PRESSURE_LIMITS, flakyEvidence, outputTail, pressureOf, readingFrom, readingNote } from "./machine-pressure";
export type { FlakyEvidence, MachineReading } from "./machine-pressure";
export { findUnownedChanges, findUnownedRunChanges, resolveRunOwnershipScope, safeRelative, validateOwnershipContract } from "./ownership";
export type { OwnershipTask } from "./ownership";
export { createProviderGate, providerListed, providerSwitchOn, waitProviderEnvironment } from "./provider-gate";
export { parseWorkspaceMode, requireManagedWorktreeProvider, resolveAttemptWorkspace, resolveManagedWorkspace, usesManagedWorktree, waitManagedWorktreeReady } from "./routing";
export { SANDBOX_OWN_ENV, prepareSandboxedCommandLine, releaseSandboxedCommandLine, runSandboxedCommandOnHost, userToolBins } from "./sandbox";
export { runStabilityDrill } from "./stability-drill";
export { WORKSPACE_DIRT_COMMAND } from "./workspace-dirt";
export { mergeInfo, revertCommitsInWorktree, worktreeState } from "./git-rollback";
export type { MergeInfo, RevertResult, WorktreeState } from "./git-rollback";
