import { AFTER_ACCEPT, SELF_REPAIR, WORKTREE_CLEANUP } from "../../contracts";

/**
 * The machine's own upkeep graphs: they never emit `lp.workflow.run-finished` (recursion guard),
 * tell no PM chat, and post nothing to the owner's list.
 */
export const INTERNAL_UPKEEP_WORKFLOWS = [
  "lp.evolve",
  "lp.review-desk",
  "lp.daily-report",
  "lp.owner-push",
  WORKTREE_CLEANUP,
  "lp.backlog-scan",
  "lead-tick",
  AFTER_ACCEPT,
  SELF_REPAIR,
  "lp.rules-scan",
  "lp.owner-bell",
  "lp.canary-check",
] as const;

const INTERNAL_UPKEEP_SET: ReadonlySet<string> = new Set(INTERNAL_UPKEEP_WORKFLOWS);

export function isInternalUpkeep(id: string): boolean {
  return INTERNAL_UPKEEP_SET.has(id);
}
