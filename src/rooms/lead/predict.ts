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
