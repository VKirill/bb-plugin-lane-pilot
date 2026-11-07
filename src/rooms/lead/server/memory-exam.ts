import { jev, type JevSettings } from "@lane-pilot/jev";
import { SANDBOX_PROJECT_ID, isDrillTask } from "../../stability/server";
import type { MemoryEvalRunner } from "../../contracts";
import { OWNER_ANSWERERS } from "../logic";
import { leadPredictJudgment, type PredictDecision, type PredictHistory } from "../predict";
import type { Db } from "./journal";

/**
 * The memory exam (roadmap §6, WP6): two measurements with a control, so the size and the order of what the lead remembers are an
 * output of a number, not a taste.
 *
 * 1. Recall: the memory-eval room's probes on the hub's own accepted tasks (right answer, nothing relevant, off-topic) at 300 notes,
 *    production retriever: hit rate on the positives, false hits on the negatives. The roadmap asks for at least 36 probes; fewer is
 *    reported as not enough, never rounded up.
 * 2. Decisions with an empty control: the owner's answered rows (exam and backtest) are predicted again twice, with the memory the
 *    live predictor has (his earlier answers to the same kind of question, only those answered before the row) and with no memory at
 *    all. The gain is the matches the memory adds. Neither arm sees a repository: the situation JSON is the whole input, so nothing
 *    of a repo leaks into the control.
 *
 * The result is stored under `lead:memory-exam` for the panel, `lead status` and the CLI. Nothing here changes a right or a row.
 */
export const MEMORY_EXAM_KEY = "lead:memory-exam";
export const MEMORY_EXAM_MIN_PROBES = 36;

export type MemoryExamArm = { decided: number; exact: number };
export type MemoryExam = {
  at: number;
  recall: { probes: number; positive: number; negative: number; offtopic: number; retriever: string; hit: number; falseHit: number; enough: boolean } | null;
  decisions: { n: number; withMemory: MemoryExamArm; control: MemoryExamArm; gain: number; predictor: string };
  caveats: string[];
};

type Row = { id: string; surface: string; class: string; risk: string | null; project_id: string | null; run_id: string | null; situation_json: string; options_json: string; answer_json: string; answered_at: number };

/** The memory arm's history: the owner's earlier answers to the same kind of question, answered before this one (no peeking forward). */
/** Whose rows the exam measures and remembers: the owner's own channels and the backtest's replay of his recorded words — never the lead's or an agent's answer (Astra F-011). */
const HUMAN = [...OWNER_ANSWERERS, "backtest"];
const HUMAN_IN = `answered_by IN (${HUMAN.map(() => "?").join(",")})`;
function historyBefore(db: Db, row: Row): PredictHistory[] {
  return (db.prepare(`SELECT situation_json, answer_json FROM lane_pilot_decision WHERE surface=? AND class=? AND id<>? AND answer_json IS NOT NULL AND answered_at<? AND split IN ('exam','backtest') AND ${HUMAN_IN} ORDER BY answered_at DESC LIMIT 20`)
    .all(row.surface, row.class, row.id, row.answered_at, ...HUMAN) as Array<{ situation_json: string; answer_json: string }>)
    .map((past) => ({ situation: past.situation_json, answer: (JSON.parse(past.answer_json) as { option: string }).option }));
}

async function predictOnce(row: Row, history: PredictHistory[], settings: JevSettings | undefined): Promise<{ decision: PredictDecision; by: string }> {
  const options = JSON.parse(row.options_json) as string[];
  try {
    const verdict = await jev()?.judge(leadPredictJudgment, {
      surface: row.surface, class: row.class, risk: row.risk, situation: JSON.parse(row.situation_json) as Record<string, unknown>, options, history,
    }, { projectId: row.project_id, runId: row.run_id, subject: "lead-memory-exam", settings });
    if (verdict?.by === "jev") return { decision: verdict.decision, by: "jev" };
    if (verdict?.by === "fallback" && verdict.shadow?.decision) return { decision: verdict.shadow.decision, by: "jev-shadow" };
  } catch { /* a failed call is a deferred row of the exam, not a failed exam */ }
  return { decision: { option: null, p: 0 }, by: "none" };
}

export async function runMemoryExam(db: Db, options: { limit?: number; settings?: JevSettings; now?: number; recall?: boolean; migrations: readonly string[] }, runEval: MemoryEvalRunner): Promise<MemoryExam> {
  const now = options.now ?? Date.now();
  const caveats: string[] = [];
  let recall: MemoryExam["recall"] = null;
  if (options.recall !== false) {
    try {
      const report = await runEval.run(runEval.load(db as never), { sizes: [300], seed: 1, scope: "project", skipProjects: new Set([SANDBOX_PROJECT_ID]), skipTask: isDrillTask, now, migrations: options.migrations });
      const size = report.sizes[0];
      const production = size?.scores.find((score) => score.production) ?? size?.scores[0];
      if (size && production) {
        const probes = size.questions.positive + size.questions.negative + size.questions.offtopic;
        recall = { probes, positive: size.questions.positive, negative: size.questions.negative, offtopic: size.questions.offtopic, retriever: production.id, hit: production.hit.mean, falseHit: production.falseHit.mean, enough: probes >= MEMORY_EXAM_MIN_PROBES };
        if (!recall.enough) caveats.push(`recall: ${probes} probes, the roadmap asks for ${MEMORY_EXAM_MIN_PROBES}: more accepted tasks with notes behind them are needed before this number means anything`);
      } else caveats.push("recall: the hub has no accepted tasks to probe yet");
      caveats.push(...report.caveats.map((line) => `recall: ${line}`));
    } catch (cause) { caveats.push(`recall: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }

  const limit = Math.max(1, Math.min(options.limit ?? 60, 500));
  const rows = db.prepare(`SELECT id, surface, class, risk, project_id, run_id, situation_json, options_json, answer_json, answered_at FROM lane_pilot_decision WHERE answer_json IS NOT NULL AND split IN ('exam','backtest') AND ${HUMAN_IN} ORDER BY answered_at DESC LIMIT ?`).all(...HUMAN, limit) as Row[];
  const withMemory: MemoryExamArm = { decided: 0, exact: 0 }, control: MemoryExamArm = { decided: 0, exact: 0 };
  let predictor = "none";
  for (const row of rows) {
    const answer = (JSON.parse(row.answer_json) as { option: string }).option;
    const [memory, empty] = await Promise.all([predictOnce(row, historyBefore(db, row), options.settings), predictOnce(row, [], options.settings)]);
    if (memory.by !== "none") predictor = memory.by;
    if (memory.decision.option !== null) { withMemory.decided += 1; if (memory.decision.option === answer) withMemory.exact += 1; }
    if (empty.decision.option !== null) { control.decided += 1; if (empty.decision.option === answer) control.exact += 1; }
  }
  if (!rows.length) caveats.push("decisions: the journal has no answered rows yet");
  else if (predictor === "none") caveats.push("decisions: Jev answered nothing (no key, off, or every call failed): both arms deferred everything");
  else if (rows.length < 20) caveats.push(`decisions: ${rows.length} rows, fewer than 20: the gain is a hint, not a number`);
  return { at: now, recall, decisions: { n: rows.length, withMemory, control, gain: withMemory.exact - control.exact, predictor }, caveats };
}

export function formatMemoryExam(exam: MemoryExam): string {
  const arm = (name: string, value: MemoryExamArm) => `${name}: decided ${value.decided}/${exam.decisions.n}, exact ${value.exact}${value.decided ? ` (${Math.round((value.exact / value.decided) * 100)} %)` : ""}`;
  return [
    `Memory exam at ${new Date(exam.at).toISOString()}`,
    exam.recall
      ? `recall: ${exam.recall.probes} probes (${exam.recall.positive} positive, ${exam.recall.negative} nothing-relevant, ${exam.recall.offtopic} off-topic)${exam.recall.enough ? "" : ` — fewer than ${MEMORY_EXAM_MIN_PROBES}`}; ${exam.recall.retriever}: hit ${Math.round(exam.recall.hit * 100)} %, false hit ${Math.round(exam.recall.falseHit * 100)} %`
      : "recall: not measured",
    `decisions (${exam.decisions.predictor}): ${arm("with memory", exam.decisions.withMemory)}; ${arm("empty control", exam.decisions.control)}; gain ${exam.decisions.gain >= 0 ? "+" : ""}${exam.decisions.gain}`,
    ...exam.caveats.map((line) => `caveat: ${line}`),
  ].join("\n");
}
