/**
 * The KV markers the worktree registry correlates with a row's owner: each pass writes its marker when it takes a
 * worktree, and the janitor reads the markers for owner liveness. They sit in storage — the registry's room — because
 * the janitor importing the passes' rooms would close an import cycle back to itself.
 */
export const DOCS_WORKTREE_PREFIX = "docs-worktree:";
export const docsWorktreeKey = (hostId: string, name: string) => `${DOCS_WORKTREE_PREFIX}${hostId}:${name}`;
/** The worktree name a marker key is for — the last segment (host ids and names carry no colon). */
export const docsWorktreeName = (key: string) => key.slice(key.lastIndexOf(":") + 1);

export const REGRESS_WORKTREE_PREFIX = "regress-worktree:";
export const regressWorktreeKey = (path: string) => `${REGRESS_WORKTREE_PREFIX}${path}`;
export const regressWorktreePath = (key: string) => key.slice(REGRESS_WORKTREE_PREFIX.length);

export const SELF_REPAIR_STATE_KEY = "self-repair:state";
export type SelfRepairWorktreeState = {
  signatures?: Record<string, {
    worktree?: { path?: string } | null;
    pending?: { worktree?: { path?: string } | null } | null;
  }>;
};
