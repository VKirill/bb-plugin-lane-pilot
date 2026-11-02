import type Database from "better-sqlite3";
import type { Answers, Judgment } from "./registry";
import type { JevAnswer, JevQuestion } from "./types";

/**
 * Model labels (H1, source B): a second judge of another model family re-answers the judgment's questions over the
 * sampled input (`input_json`, one receipt in five), never seeing the decision Jev recorded. Its re-decision is compared
 * with the receipt's text and the outcome lands as `agree:model` / `disagree:model`.
 *
 * The caps: at most `PER_JUDGMENT` relabels a night per judgment and `PER_NIGHT` in all — the analyzer threads are the
 * cost of the night graph. Judgments with `box` questions or assets are skipped: their answer cannot be re-rendered from
 * text.
 */

export const MODEL_LABEL_PER_JUDGMENT = 20;
export const MODEL_LABEL_PER_NIGHT = 120;

type Db = Pick<Database.Database, "prepare">;

export type ModelLabelJob = { receiptId: number; judgment: string; input: unknown };

/** The sampled receipts of one judgment that still have no label: oldest first, the nights fill the back catalog first. */
export function planModelLabels(db: Db, judgments: ReadonlyArray<Pick<Judgment<unknown, unknown>, "id">>, opts: { perJudgment?: number; total?: number } = {}): ModelLabelJob[] {
  const perJudgment = opts.perJudgment ?? MODEL_LABEL_PER_JUDGMENT;
  const total = opts.total ?? MODEL_LABEL_PER_NIGHT;
  const out: ModelLabelJob[] = [];
  for (const { id } of judgments) {
    if (out.length >= total) break;
    const rows = db.prepare(`SELECT id, input_json FROM lane_pilot_jev_receipt
      WHERE judgment=? AND outcome IS NULL AND status='ok' AND decision IS NOT NULL AND input_json IS NOT NULL
      ORDER BY at LIMIT ?`).all(id, perJudgment) as Array<{ id: number; input_json: string }>;
    for (const row of rows) {
      if (out.length >= total) break;
      try { out.push({ receiptId: row.id, judgment: id, input: JSON.parse(row.input_json) }); } catch { /* a truncated input is skipped */ }
    }
  }
  return out;
}

/**
 * The prompt the second judge answers: the state and the questions rendered as Jev saw them (re-rendered from the stored
 * input through the same stateBuilder and questions), plus the answer contract. The judge's own decision and answers are
 * never part of it — the labeler is blind by construction (pinned by a repo test).
 */
export function modelLabelPrompt(judgment: Pick<Judgment<unknown, unknown>, "id" | "stateBuilder" | "questions">, input: unknown): string {
  const state = judgment.stateBuilder(input);
  const questions = judgment.questions(input);
  const q = Object.fromEntries(Object.entries(questions).filter(([, question]) => question.type !== "box").map(([id, question]) => [id, question]));
  return [
    "You are re-judging a decision a software pipeline made. Below is the state the judge saw and the questions it was asked, exactly as they were rendered.",
    "Answer every question yourself and reply with ONLY a JSON object mapping each question id to your answer:",
    "- choice: the option name you pick (one of the criteria keys)",
    "- noul: true or false",
    "- score: a number matching the criteria scale",
    "",
    "state:",
    JSON.stringify(state),
    "",
    "questions:",
    JSON.stringify(q),
    "",
    "Reply with the JSON object only. No prose, no code fence.",
  ].join("\n");
}

/** The analyzer's JSON answer turned into the Answers shape `decide` reads: the picked option at probability 1. */
export function answersFromModelText(text: string, questions: Record<string, JevQuestion>): Answers | null {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
  const answers: Answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const value = parsed[id];
    if (value === undefined || value === null) continue;
    if (question.type === "choice" && typeof value === "string" && value in question.criteria) {
      answers[id] = { type: "choice", choice: value, probabilities: Object.fromEntries(Object.keys(question.criteria).map((name) => [name, name === value ? 1 : 0])), confidence: 1 } satisfies JevAnswer;
    } else if (question.type === "noul" && typeof value === "boolean") {
      answers[id] = { type: "noul", noul: value ? 1 : 0 };
    } else if (question.type === "score" && typeof value === "number" && Number.isFinite(value)) {
      answers[id] = { type: "score", score: value, legend: {}, probabilities: {}, confidence: 1 };
    }
  }
  return Object.keys(answers).length ? answers : null;
}

/**
 * The comparison: the second judge's answers are decided by the judgment's own rule on the registry-default thresholds,
 * and the produced decision text is matched with the receipt's (`escalate:<to>` vs `describe(decision)`). Returns the
 * outcome to write, or null when the model's answer could not be read or decided.
 */
export function compareModelDecision(
  judgment: Pick<Judgment<unknown, unknown>, "id" | "questions" | "decide" | "describe" | "thresholds">,
  input: unknown,
  modelText: string,
  receiptDecision: string | null,
): "agree:model" | "disagree:model" | null {
  if (!receiptDecision) return null;
  const answers = answersFromModelText(modelText, judgment.questions(input));
  if (!answers) return null;
  const thresholds = Object.fromEntries(Object.entries(judgment.thresholds).map(([name, spec]) => [name, spec.default]));
  let text: string;
  try {
    const decided = judgment.decide(answers, thresholds, input);
    text = decided.escalate !== undefined ? `escalate:${decided.escalate}` : judgment.describe(decided.decision);
  } catch { return null; }
  return text === receiptDecision ? "agree:model" : "disagree:model";
}

/** A judgment whose questions are all re-answerable from text (no `box`, which needs the image). */
export function modelLabelable(judgment: Pick<Judgment<unknown, unknown>, "questions">, input: unknown): boolean {
  return Object.values(judgment.questions(input)).every((question) => question.type !== "box");
}
