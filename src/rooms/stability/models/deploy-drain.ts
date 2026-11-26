/** Host calls that write to a git checkout; a reload must not cut one off midway. */
export const CHECKOUT_WRITING_METHODS = new Set(["gitIntegrate", "gitCreateWorktree", "gitRemoveWorktree", "gitPrepareWorktree", "gitOwnsBarrier", "gitCommitDocs",
  "gitRevertPaths", "gitRevertCommits", "gitUndoCheckWrites", "gitWorktreeSnapshot", "snapshot", "rollback", "install", "applyOnboardingPages", "writeDocsPages", "writeWorkflowFile"]);

/** Acceptance checks run on the machine as plain calls; a reload kills one midway and the attempt fails with it. */
export const ACCEPTANCE_METHODS = new Set(["runSandboxedCommand"]);

export const DRAIN_SNAPSHOT_KEY = "drain:snapshot";

export type DrainSnapshot = { action?: string; clean?: boolean; inFlight?: unknown[] };
