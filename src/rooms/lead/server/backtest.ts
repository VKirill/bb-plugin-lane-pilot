import { listPhases } from "../../phase";
import { taskFamily } from "../../runs";
import { listTasksForRun, type LanePilotDatabase } from "../../storage";
import { TASK_WORDS_KEY, type TaskWord } from "../../tasks";
import { answerDecision, listDecisions, openDecision, predictDecision } from "./journal";
import { phaseDecisionId, phaseSituation, WORD_OPTIONS, wordDecisionId, wordSituation } from "./surfaces";

/**
 * The backtest (roadmap WP2 acceptance): the decisions the owner already made before the journal existed — his words on tasks
 * (`lp.task.words`) and on phase turns — replayed through the predictor. The prediction is made after the answer, so every row lands in
 * split `backtest` with `predicted_at ≥ answered_at`: a report of how close the lead is to the owner, never a row of the exam and never
 * a right. Running it again adds only what is new (the ids are the surfaces' own).
 */
type Kv = { get(key: string): Promise<unknown> };
export type BacktestReport = {
  created: number; skipped: string[];
  classes: Array<{ class: string; n: number; decided: number; exact: number; miss: number; deferred: number; accuracy: number | null }>;
};

export async function backtest(db: LanePilotDatabase, kv: Kv, now: number = Date.now()): Promise<BacktestReport> {
  let created = 0;
  const skipped: string[] = [];
  const replay = async (id: string, open: () => { created: boolean }, decision: "yes" | "no", text: string, at: number) => {
    if (!open().created) return;
    created += 1;
    await predictDecision(db, id, undefined, now); // ponytail: one Jev call per row; judgeMany when the history is thousands, not dozens
    answerDecision(db, id, { option: decision, text }, "backtest", at);
  };
  const words = ((await kv.get(TASK_WORDS_KEY).catch(() => null)) as Record<string, TaskWord[]> | null) ?? {};
  for (const [key, list] of Object.entries(words)) {
    const word = [...list].reverse().find((row) => row.turn === "land");
    const cut = key.indexOf(":");
    if (!word || cut < 0) { skipped.push(`${key}: no landing word`); continue; }
    const runId = key.slice(0, cut), family = key.slice(cut + 1);
    const task = listTasksForRun(db, runId).find((row) => taskFamily(row.id) === family);
    const contract = task?.contract as { title?: string; risk?: string; objective?: string; invariants?: string[] } | undefined;
    if (!contract?.title) { skipped.push(`${key}: task not on the hub`); continue; }
    const spec = { ...contract, title: contract.title };
    const project = (db.prepare("SELECT project_id FROM lane_pilot_run WHERE id=?").get(runId) as { project_id: string } | undefined)?.project_id ?? null;
    await replay(wordDecisionId(runId, family), () => openDecision(db, { id: wordDecisionId(runId, family), surface: "words", class: "landing", risk: spec.risk ?? null, projectId: project, runId,
      situation: wordSituation(spec, family), options: WORD_OPTIONS, split: "backtest", createdAt: word.at }, word.at), word.decision, word.text, word.at);
  }
  for (const phase of listPhases(db, { limit: 1_000 })) {
    for (const word of phase.record.words ?? []) {
      const id = phaseDecisionId(phase.id, word.turn, word.wave);
      await replay(id, () => openDecision(db, { id, surface: "phase", class: "process", projectId: phase.projectId, runId: phase.runId,
        situation: phaseSituation(phase, word.turn, word.wave, `backtest: the word at ${word.turn}`), options: WORD_OPTIONS, split: "backtest", createdAt: word.at }, word.at), word.decision, word.text, word.at);
    }
  }
  const rows = listDecisions(db, { split: "backtest", limit: 100_000 });
  const classes = [...new Set(rows.map((row) => row.class))].sort().map((cls) => {
    const mine = rows.filter((row) => row.class === cls);
    const count = (verdict: string) => mine.filter((row) => row.judge_verdict === verdict).length;
    const decided = mine.length - count("deferred");
    return { class: cls, n: mine.length, decided, exact: count("exact"), miss: count("miss"), deferred: count("deferred"), accuracy: decided ? count("exact") / decided : null };
  });
  return { created, skipped, classes };
}
