import { closeOwnerItemsByPrefix, decidedOwnerItem } from "../../../owner-waiting";
import { taskWordItemPrefix } from "../../../contracts";
import type { LanePilotDatabase } from "../../../storage";
import { WORD_OPTIONS, wordDecisionId, wordSituation, type WordTask } from "../../models/surfaces";

export { WORD_OPTIONS, wordDecisionId, wordSituation, type WordTask };

type Db = Pick<LanePilotDatabase, "prepare">;

/** finish.ts: the attempt starts waiting for the word (journal/rights removed; no-op kept for TaskWordPort parity). */
export const askTaskWord = async (_db: Db, _input: { runId: string; projectId: string; family: string; task: WordTask }, _settings?: Record<string, unknown>, _now?: number): Promise<void> => {};

/** lane_pilot_queue word, the task_word RPC: the waiting question leaves the owner's list. */
export const answerTaskWord = (db: Db, runId: string, family: string, decision: "yes" | "no", _text: string, by: string, now?: number) => {
  try { closeOwnerItemsByPrefix(db as never, taskWordItemPrefix(runId, family), `${decision === "yes" ? "approved" : "returned"}:${by}`, now); } catch { /* the janitor takes it later */ }
};

/**
 * Decision claim by compare-and-set (SMA tr_approving): the first press closes the waiting rows with the outcome and wins;
 * a second press on the same waiting candidate finds its row already decided and is refused, naming who decided and when.
 * A word given before any wait row exists, or after the decided candidate ended (the owner changed his mind after a «no»,
 * a redo runs), is a new word and is recorded — otherwise dispatch's «record a new yes» way out could never be taken.
 */
export const decideTaskWord = (db: Db, runId: string, family: string, decision: "yes" | "no", by: string, now: number = Date.now(), waitingAttemptId?: string | null): { ok: true } | { ok: false; reason: string } => {
  try {
    const changed = closeOwnerItemsByPrefix(db as never, taskWordItemPrefix(runId, family), `${decision === "yes" ? "approved" : "returned"}:${by}`, now);
    if (changed) return { ok: true };
    const decided = decidedOwnerItem(db as never, taskWordItemPrefix(runId, family));
    if (decided && waitingAttemptId && decided.key === `${taskWordItemPrefix(runId, family)}${waitingAttemptId}`) return { ok: false, reason: `already decided: ${decided.by} at ${new Date(decided.at).toISOString()}` };
  } catch { /* an older database without the table records the word as before */ }
  return { ok: true };
};

/** The task-word surface as one object, for the services bag. */
export const taskWordPort = { ask: askTaskWord, answer: answerTaskWord, decide: decideTaskWord } as const;
