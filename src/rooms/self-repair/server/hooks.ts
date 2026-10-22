import type { Incident, RepairWorktree, Verdict } from "./self-repair";

/**
 * How the night loop (src/rooms/wall) uses the self-repair path. The loop does not spawn repair threads itself: it queues an assignment and
 * the watcher's own tick starts it, so the watcher's state (worktrees, verdicts, the merge under the base lock) has one writer. The loop is
 * asked before a fixed repair's branch is merged: the night policy decides whether the night may merge it alone.
 */
export type NightAssignment = {
  id: string;
  /** The key in the watcher's state: `night:<hash>:<class and reason>`. */
  signature: string;
  samples: Incident[];
  /** Appended to the standard repair prompt. */
  brief: string;
  /** Another model than the engineer's for the informed round; absent: the configured repair model. */
  selection?: { providerId: string; model: string; reasoningLevel: string };
};

export type MergeDecision = "merge" | "hold" | "release";

export type RepairHooks = {
  nextAssignment(): NightAssignment | null;
  started(id: string, info: { threadId: string; branch: string; at: number }): void;
  startFailed(id: string, reason: string): void;
  /** Called on every pass while a night repair's verdict is `fixed` and its branch is not merged yet; must be cheap and settle once. */
  mergeGate(signature: string, info: { threadId: string; worktree: RepairWorktree }): Promise<MergeDecision>;
  /** The repair's worktree is gone: merged (`commit`), released, or abandoned. */
  settled(signature: string, info: { outcome: string; verdict: Verdict | null; commit: string | null }): void;
};

const registry = new WeakMap<object, RepairHooks>();
export const setRepairHooks = (owner: object, hooks: RepairHooks): void => { registry.set(owner, hooks); };
export const getRepairHooks = (owner: object): RepairHooks | undefined => registry.get(owner);
