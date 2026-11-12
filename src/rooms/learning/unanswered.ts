import type { Db } from "./store";

/**
 * «A question the memory did not answer» (SMA block 4, P0-3 step 5). A signal the learning room already keeps:
 *  - `ownerRepeats`: items of state `duplicate` — the owner said again something already in force (a rule or an earlier item), the
 *    extractor matched it and `confirmations` counted it. The rule existed, yet he had to say it: either it did not reach the agent
 *    he spoke to, or the agent did not follow it.
 * Counted per project over a window; it acts on nothing. The memory probe report carries them next to the delivery table.
 */
export type MemoryUnanswered = { windowDays: number; ownerRepeats: number; repeatConfirmations: number };

const DAY_MS = 86_400_000;

export function memoryUnanswered(db: Db, projectId: string, windowDays = 30, now = Date.now()): MemoryUnanswered {
  const since = now - windowDays * DAY_MS;
  const items = db.prepare("SELECT count(*) AS n, COALESCE(sum(confirmations),0) AS confirmations FROM lane_pilot_learning_item WHERE project_id=? AND state='duplicate' AND created_at>=?")
    .get(projectId, since) as { n: number; confirmations: number };
  return { windowDays, ownerRepeats: items.n, repeatConfirmations: items.confirmations };
}
