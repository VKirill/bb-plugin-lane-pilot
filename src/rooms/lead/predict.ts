import { choice, choiceOf, defineJudgment } from "@lane-pilot/jev";

/**
 * The lead's prediction of the owner's answer, made before he answers (roadmap §2.4). One Choice over the surface's options, with the
 * situation and the owner's recent answers to the same kind of question as the memory the guess is made from. Shadow by default: the
 * verdict's `shadow` decision is what the journal records; nothing acts on it until a class passes the exam (roadmap §6, src/rooms/lead/logic.ts).
 * Below `min_p` the lead defers rather than guesses: a deferred row counts against coverage, never against accuracy.
 */
export const LEAD_PREDICT_ID = "lead.predict";

export type PredictHistory = { situation: string; answer: string };
export type PredictInput = { surface: string; class: string; risk: string | null; situation: Record<string, unknown>; options: string[]; history: PredictHistory[] };
export type PredictDecision = { option: string | null; p: number };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const leadPredictJudgment = defineJudgment<PredictInput, PredictDecision>({
  id: LEAD_PREDICT_ID,
  title: "Какой ответ даст владелец",
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    surface: input.surface, class: input.class, risk: input.risk,
    situation: JSON.parse(clip(JSON.stringify(input.situation), 3_000)) as unknown ?? clip(JSON.stringify(input.situation), 3_000),
    owner_history: input.history.slice(0, 20).map((row) => ({ situation: clip(row.situation, 300), answer: row.answer })),
  }),
  questions: (input) => ({
    option: choice("`situation` is a question the owner of this software is being asked; `owner_history` holds his answers to earlier questions of the same kind, newest first. Which option will he choose this time?",
      Object.fromEntries(input.options.map((option) => [option, `the owner answers «${option}»`]))),
  }),
  thresholds: {
    min_p: { default: 0.6, min: 0.5, max: 0.95, about: "least probability of the top option before the lead predicts instead of deferring" },
  },
  decide(answers, t) {
    const top = choiceOf(answers, "option");
    if (!top) return { decision: { option: null, p: 0 } };
    return { decision: { option: top.p >= t.min_p! ? top.top : null, p: top.p } };
  },
  fallback: () => ({ option: null, p: 0 }),
  describe: (decision) => decision.option ?? "deferred",
});

/**
 * The model judge (roadmap §6): the rule judge scores exact and deferred by itself; a mismatch is shown to Jev with the owner's words,
 * which says whether the lead's guess was the owner's direction with a different timing or wording (`partial`, half a match in the exam)
 * or simply wrong (`miss`). Shadow by default like the predictor; without Jev the rule's `miss` stands.
 */
export const LEAD_JUDGE_ID = "lead.judge";
export type JudgeInput = { surface: string; class: string; situation: Record<string, unknown>; options: string[]; prediction: { option: string; p: number }; answer: { option: string; text?: string } };
export type JudgeDecision = { verdict: "partial" | "miss" };

export const leadJudgeJudgment = defineJudgment<JudgeInput, JudgeDecision>({
  id: LEAD_JUDGE_ID,
  title: "Было ли предсказание в направлении ответа",
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    surface: input.surface, class: input.class,
    situation: JSON.parse(clip(JSON.stringify(input.situation), 3_000)) as unknown ?? clip(JSON.stringify(input.situation), 3_000),
    options: input.options, predicted: input.prediction.option, answered: input.answer.option, owner_words: clip(input.answer.text ?? "", 600),
  }),
  questions: () => ({
    verdict: choice("`situation` is a question the owner of this software was asked, `predicted` is what the lead guessed he would answer, `answered` is what he answered and `owner_words` what he wrote. Was the guess the owner's direction with another timing or wording, or simply wrong?", {
      partial: "the guess had the owner's direction: he said «later» to a «yes», or his words accept the substance and change the timing or the wording",
      miss: "the guess was wrong: the owner went the other way, or his words reject the substance",
    }),
  }),
  thresholds: {
    min_p: { default: 0.6, min: 0.5, max: 0.95, about: "least probability of «partial» before a miss is softened to a partial" },
  },
  decide(answers, t) {
    const top = choiceOf(answers, "verdict");
    return { decision: { verdict: top?.top === "partial" && top.p >= t.min_p! ? "partial" : "miss" } };
  },
  fallback: () => ({ verdict: "miss" }),
  describe: (decision) => decision.verdict,
});
