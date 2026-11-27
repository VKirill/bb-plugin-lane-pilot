// Public API of verification: what other rooms and host handlers import. Everything else in this room is private.
export * from "./models";
export { gitOwnershipChangedPaths, resolveGitOwnershipBase, undoCheckWrites } from "./git-ownership";
export { attributeGateOnHost, bisectGateOnHost, runGateOnHost } from "./integration-gate-host";
export { darwinAvailableBytes, readMachineFacts } from "./machine-reading";
export type { HostMachineFacts } from "./machine-reading";
export { prepareSandboxedCommandLine, releaseSandboxedCommandLine, runSandboxedCommandOnHost, userToolBins } from "./sandbox";
export { mergeInfo, revertCommitsInWorktree, worktreeState } from "./git-rollback";
export type { MergeInfo, RevertResult, WorktreeState } from "./git-rollback";
export { cachedReplayVerdicts, recordedReplayFailure, recordReplayVerdict, replayCacheLocation, replayKey } from "./replay-cache";
export type { ReplayCacheEntry } from "./replay-cache";
export { DEFAULT_WORKER } from "./worker-user";
export { CREDENTIAL_DIRS, CREDENTIAL_FILES, CREDENTIAL_SYMLINK_DIRS, credentialDirs, resolveCredentialPaths } from "./credential-paths";
