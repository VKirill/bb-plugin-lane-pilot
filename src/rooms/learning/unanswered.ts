import type { Db } from "./store";

/**
 * «A question the memory did not answer» (SMA block 4, P0-3 step 5). Two signals the learning room already keeps:
 *  - `ownerRepeats`: items of state `duplicate` — the owner said again something already in force (a rule or an earlier item), the
 *    extractor matched it and `confirmations` counted it. The rule existed, yet he had to say it: either it did not reach the agent
 *    he spoke to, or the agent did not follow it. Items are written only when the learning room is in `active` mode.
 *  - `routableQuestions`: `owner_question` signals — a question an agent put to the owner that another agent, the files or the
 *    memory could have answered (Jev read, p >= `MIN_P`). Written in observation mode too.
 * Both are counted per project over a window; neither acts on anything. The memory probe report carries them next to the delivery table.
 */
export type MemoryUnanswered = { windowDays: number; ownerRepeats: number; repeatConfirmations: number; routableQuestions: number };

const MIN_P = 0.6;
const DAY_MS = 86_400_000;

export function memoryUnanswered(db: Db, projectId: string, windowDays = 30, now = Date.now()): MemoryUnanswered {
  const since = now - windowDays * DAY_MS;
  const items = db.prepare("SELECT count(*) AS n, COALESCE(sum(confirmations),0) AS confirmations FROM lane_pilot_learning_item WHERE project_id=? AND state='duplicate' AND created_at>=?")
    .get(projectId, since) as { n: number; confirmations: number };
  const questions = db.prepare("SELECT count(*) AS n FROM lane_pilot_learning_signal WHERE kind='owner_question' AND project_id=? AND at>=? AND COALESCE(p,0)>=?")
    .get(projectId, since, MIN_P) as { n: number };
  return { windowDays, ownerRepeats: items.n, repeatConfirmations: items.confirmations, routableQuestions: questions.n };
}
