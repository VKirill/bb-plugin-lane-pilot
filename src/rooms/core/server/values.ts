/** Set right before a worktree holder thread is spawned for an attempt: the one case a holder can be lost. */
export const holderSpawnKey = (attemptId:string) => `holder-spawn:${attemptId}`;
