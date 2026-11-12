import type { Decisions } from "./decide";
import { listItems, type Db } from "./store";

/**
 * Learning without the owner (owner out of the loop, 2026-10-22): the «yes» to an item (a date, a global preference, a statement that
 * contradicts one in force). The owner said it himself in his message, so it is accepted. A reminder is set, a contradicting rule
 * goes on trial (and is retired by the trial if it does not help), and a global preference is written by the server itself
 * (`bb memory add` argv from decide.ts); the outcome lands on the item. (The old check of the judges by a model is gone with the judges.)
 */
export type AutonomyDeps = {
  db: Db;
  decisions: Pick<Decisions, "accept">;
  /** The project asks for the owner's word (owner.words = on): its waiting items stay for him (SMA: Draft awaits a person, Person applies the draft). */
  ownerWords?(projectId: string): boolean;
  log(line: string): void;
};

export function createAutonomy(deps: AutonomyDeps) {
  /** Accepts what waited for the owner's «yes»; a global preference goes to the project's PM to save. */
  async function settleWaiting() {
    const settled: Array<{ id: string; state: string }> = [];
    for (const item of listItems(deps.db, { states: ["pending_owner"], limit: 50 })) {
      // Approval path (SMA): with owner.words on, an item that waits for the owner is applied only by his word, not settled here.
      if (deps.ownerWords?.(item.projectId)) continue;
      try {
        const decided = await deps.decisions.accept(item.id);
        settled.push({ id: item.id, state: decided.item.state });
        if (decided.note) deps.log(`learning: ${item.id}: ${decided.note}`);
      } catch (cause) {
        deps.log(`learning: could not settle ${item.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return settled;
  }

  return { settleWaiting };
}
export type Autonomy = ReturnType<typeof createAutonomy>;
