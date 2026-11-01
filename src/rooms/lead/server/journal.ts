import type Database from "better-sqlite3";
import { jev, type JevSettings } from "@lane-pilot/jev";
import { type ExamRow, type Verdict } from "../logic";
import { leadPredictJudgment, type PredictDecision } from "../predict";

/**
 * The journal's three moves (roadmap §2.4): a surface OPENS a decision when its question appears (situation and options as the owner
 * will see them), the lead PREDICTS at once and the prediction is stamped with its time, the owner's answer CLOSES the row and the rule
 * judge scores it. The judge here is the rule «same option = exact, no prediction = deferred, else miss»; a model judge that knows
 * `partial` comes with the morning-list labels (WP6). An id is the surface's own key, so opening twice is one row and the backtest
 * can never overwrite a live decision (INSERT OR IGNORE).
 */
export type Db = Pick<Database.Database, "prepare" | "transaction">;

export type DecisionRow = {
  id: string; project_id: string | null; run_id: string | null; surface: string; class: string; risk: string | null;
  situation_json: string; options_json: string;
  prediction_json: string | null; predicted_at: number | null; predictor: string | null;
  answer_json: string | null; answered_at: number | null; answered_by: string | null;
  judge_verdict: Verdict | null; judge_model: string | null; judged_at: number | null;
  owner_label: Verdict | null; labeled_at: number | null; policy_version: number | null; split: "exam" | "design" | "backtest"; created_at: number;
};

export type OpenDecision = {
  id: string; surface: string; class: string; risk?: string | null; projectId?: string | null; runId?: string | null;
  situation: Record<string, unknown>; options: readonly string[]; split?: DecisionRow["split"]; createdAt?: number;
};
export type Answer = { option: string; text?: string };

export const POLICY_VERSION = 1;

export function openDecision(db: Db, input: OpenDecision, now: number = Date.now()): { created: boolean } {
  if (!input.id.trim() || input.options.length < 2) throw new Error("a decision needs an id and at least two options");
  const result = db.prepare(`INSERT OR IGNORE INTO lane_pilot_decision(id,project_id,run_id,surface,class,risk,situation_json,options_json,policy_version,split,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.projectId ?? null, input.runId ?? null, input.surface, input.class, input.risk ?? null,
    JSON.stringify(input.situation), JSON.stringify(input.options), POLICY_VERSION, input.split ?? "exam", input.createdAt ?? now);
  return { created: result.changes > 0 };
}

export const getDecision = (db: Db, id: string): DecisionRow | undefined => db.prepare("SELECT * FROM lane_pilot_decision WHERE id=?").get(id) as DecisionRow | undefined;

/** The owner's recent answers to the same kind of question: the memory the prediction is made from. */
function historyOf(db: Db, row: DecisionRow): Array<{ situation: string; answer: string }> {
  const rows = db.prepare("SELECT situation_json, answer_json FROM lane_pilot_decision WHERE surface=? AND class=? AND id<>? AND answer_json IS NOT NULL ORDER BY answered_at DESC LIMIT 20")
    .all(row.surface, row.class, row.id) as Array<{ situation_json: string; answer_json: string }>;
  return rows.map((past) => ({ situation: past.situation_json, answer: (JSON.parse(past.answer_json) as Answer).option }));
}

/**
 * Writes the prediction once, before the answer; a row already predicted or already answered is left alone. Shadow mode is the normal one:
 * the verdict's `shadow` decision is the prediction. Without Jev (no key, off, a failure) the lead defers, and the row says so.
 */
export async function predictDecision(db: Db, id: string, settings?: JevSettings, now: number = Date.now()): Promise<PredictDecision | null> {
  const row = getDecision(db, id);
  if (!row || row.predicted_at !== null || row.answered_at !== null) return null;
  const options = JSON.parse(row.options_json) as string[];
  let decision: PredictDecision = { option: null, p: 0 };
  let predictor = "none";
  try {
    const verdict = await jev()?.judge(leadPredictJudgment, {
      surface: row.surface, class: row.class, risk: row.risk, situation: JSON.parse(row.situation_json) as Record<string, unknown>, options, history: historyOf(db, row),
    }, { projectId: row.project_id, runId: row.run_id, subject: "lead-predict", settings });
    if (verdict?.by === "jev") { decision = verdict.decision; predictor = `jev:${leadPredictJudgment.id}@${leadPredictJudgment.version}`; }
    else if (verdict?.by === "fallback" && verdict.shadow?.decision) { decision = verdict.shadow.decision; predictor = `jev-shadow:${leadPredictJudgment.id}@${leadPredictJudgment.version}`; }
  } catch { /* a prediction never blocks a surface */ }
  if (decision.option !== null && !options.includes(decision.option)) decision = { option: null, p: decision.p };
  db.prepare("UPDATE lane_pilot_decision SET prediction_json=?, predicted_at=?, predictor=? WHERE id=? AND predicted_at IS NULL AND answered_at IS NULL")
    .run(JSON.stringify(decision), now, predictor, id);
  return decision;
}

/** Open and predict in one call: what every surface does when its question appears. Errors stay here: a surface never fails on its journal. */
export async function askDecision(db: Db, input: OpenDecision, settings?: JevSettings, now: number = Date.now()): Promise<void> {
  try {
    openDecision(db, input, now);
    await predictDecision(db, input.id, settings, now);
  } catch { /* journal only */ }
}

/** The rule judge: the same option is exact, no prediction is deferred, anything else is a miss. `partial` waits for the model judge. */
export function ruleVerdict(prediction: PredictDecision | null, answer: Answer): Verdict {
  if (!prediction || prediction.option === null) return "deferred";
  return prediction.option === answer.option ? "exact" : "miss";
}

/** The owner answered: the row closes once (the first answer stands) and the rule judge scores it at once. */
export function answerDecision(db: Db, id: string, answer: Answer, by: string, now: number = Date.now()): DecisionRow | undefined {
  const row = getDecision(db, id);
  if (!row || row.answered_at !== null) return row;
  const prediction = row.prediction_json ? (JSON.parse(row.prediction_json) as PredictDecision) : null;
  const verdict = ruleVerdict(prediction, answer);
  db.prepare("UPDATE lane_pilot_decision SET answer_json=?, answered_at=?, answered_by=?, judge_verdict=?, judge_model='rule', judged_at=? WHERE id=? AND answered_at IS NULL")
    .run(JSON.stringify({ option: answer.option, ...(answer.text ? { text: answer.text.slice(0, 2_000) } : {}) }), now, by.slice(0, 200), verdict, now, id);
  return getDecision(db, id);
}

/** The owner's own label on a judged row (the kappa of the judge is measured against these). */
export function labelDecision(db: Db, id: string, label: Verdict, now: number = Date.now()): boolean {
  return db.prepare("UPDATE lane_pilot_decision SET owner_label=?, labeled_at=? WHERE id=? AND answered_at IS NOT NULL").run(label, now, id).changes > 0;
}

export function listDecisions(db: Db, filter: { class?: string; surface?: string; split?: string; limit?: number } = {}): DecisionRow[] {
  const where: string[] = []; const params: unknown[] = [];
  if (filter.class) { where.push("class=?"); params.push(filter.class); }
  if (filter.surface) { where.push("surface=?"); params.push(filter.surface); }
  if (filter.split) { where.push("split=?"); params.push(filter.split); }
  return db.prepare(`SELECT * FROM lane_pilot_decision ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...params, filter.limit ?? 50) as DecisionRow[];
}

export const examRows = (db: Db): ExamRow[] =>
  db.prepare("SELECT class, risk, judge_verdict, owner_label, predicted_at, answered_at, split, answered_by FROM lane_pilot_decision WHERE answered_at IS NOT NULL").all() as ExamRow[];
