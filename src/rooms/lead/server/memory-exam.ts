import type { JevSettings } from "@lane-pilot/jev";
import { SANDBOX_PROJECT_ID, isDrillTask } from "../../contracts";
import type { MemoryEvalRunner } from "../../contracts";
import { OWNER_ANSWERERS } from "../logic";
import type { Db } from "./journal";

/**
 * The memory exam (roadmap §6, WP6): two measurements with a control, so the size and the order of what the lead remembers are an
 * output of a number, not a taste.
 *
 * 1. Recall: the memory-eval room's probes on the hub's own accepted tasks (right answer, nothing relevant, off-topic) at 300 notes,
 *    production retriever: hit rate on the positives, false hits on the negatives. The roadmap asks for at least 36 probes; fewer is
 *    reported as not enough, never rounded up.
 * 2. Decisions with an empty control: the lead has no predictor, so both arms defer every answered row (decided 0, gain 0).
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

/** Whose rows the exam measures: the owner's own channels and the backtest's replay of his recorded words — never the lead's or an agent's answer (Astra F-011). */
const HUMAN = [...OWNER_ANSWERERS, "backtest"];
const HUMAN_IN = `answered_by IN (${HUMAN.map(() => "?").join(",")})`;

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
  const predictor = "none";
  if (!rows.length) caveats.push("decisions: the journal has no answered rows yet");
  else caveats.push("decisions: the lead has no predictor: both arms deferred everything");
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
