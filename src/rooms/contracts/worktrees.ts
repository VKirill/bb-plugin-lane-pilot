/**
 * The liveness keys the self-managed passes leave in KV and the worktree janitor (stability) reads to tell a live copy
 * from a dead one. They live in contracts because stability cannot import the owning rooms (self-repair imports
 * stability): the strings stay byte-identical and tests/worktree-keys.test.ts pins them.
 */

const DOCS_WORKTREE_PREFIX = "docs-worktree:";

/** A docs pass's reuse marker names its copy: `docs-worktree:<hostId>:<name>`. */
export const docsWorktreeKey = (hostId: string, name: string) => `${DOCS_WORKTREE_PREFIX}${hostId}:${name}`;
export { DOCS_WORKTREE_PREFIX };

const REGRESS_WORKTREE_PREFIX = "regress-worktree:";

/** A bounded regress pass's in-flight marker: `regress-worktree:<path>`. */
export const regressWorktreeKey = (path: string) => `${REGRESS_WORKTREE_PREFIX}${path}`;
export const regressWorktreePath = (key: string) => key.slice(REGRESS_WORKTREE_PREFIX.length);
export { REGRESS_WORKTREE_PREFIX };

/** The marker lives for six hours — the same window the regress sweep applies before it reaps a leftover. */
export const REGRESS_MARKER_TTL_MS = 6 * 3_600_000;

/** The self-repair pass's state record. */
export const SELF_REPAIR_STATE_KEY = "self-repair:state";

export type RepairWorktreeRef = { hostId?: string; path?: string; branch?: string };

/** Every worktree a self-repair state record still holds, with its signature: the signatures' own and their pending spawns'. */
export function selfRepairWorktrees(raw: unknown): Array<{ signature: string; worktree: RepairWorktreeRef }> {
  const signatures = (raw as { signatures?: unknown } | null)?.signatures;
  if (!signatures || typeof signatures !== "object") return [];
  return Object.entries(signatures as Record<string, { worktree?: RepairWorktreeRef | null; pending?: { worktree?: RepairWorktreeRef | null } | null }>)
    .flatMap(([signature, record]) => [record?.worktree ?? null, record?.pending?.worktree ?? null]
      .filter((worktree): worktree is RepairWorktreeRef => worktree !== null)
      .map((worktree) => ({ signature, worktree })));
}
