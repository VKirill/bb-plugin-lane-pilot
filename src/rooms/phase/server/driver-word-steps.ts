import { bestEffort } from "@lane-pilot/kit";
import { discussionGate, phaseFolder, planGate, stageTurn, wordAsked, type Phase } from "../logic";
import { specText } from "../stages";
import { savePhase } from "../store";
import { PhaseRefusal } from "./driver-tools";
import type { StepsTools } from "./driver-steps";

/** A PM at work answers a stage question first (the writer's ASK_PM grace, writer/server/question-default.ts PM_ACTIVE_GRACE_MS). */
export const MACHINE_ANSWER_GRACE_MS = 5 * 60_000;
export const MACHINE_ANSWERER = "Lane Pilot (owner.words sensitive)";
export const MACHINE_STAGE_ANSWER = "The owner is asked only about money, database migrations and production deploys, and this stage touches none of them: take the narrower reading — the one that keeps the existing behaviour, the context's locked decisions and the plan's scope — and name the choice in the stage's result. A later stage, the verifier or the owner at acceptance may revisit it.";

/** The two steps of a phase's tick that follow from its per-turn owner words (logic/words-policy.ts) on owner.words=sensitive. */
export function installWordSteps(tools: StepsTools) {
  const { ctx, db, now, mustGet, book, move, writeGenerated } = tools;

  /**
   * owner.words=sensitive (default-path audit §5.4.4): a blocking question of a stage whose turn is outside money, data and production
   * deploys does not wait for the owner. Like a writer's ASK_PM (0.1.556), a PM at work gets five minutes first; then Lane Pilot answers
   * it by rule — the narrower reading, kept as a decision in the book — and the gate goes on. On `on`, `risky` and `off` nothing changes.
   */
  function machineAnswers(phase: Phase): Phase {
    const turn = stageTurn(phase.stage);
    if (phase.record.wordTurns?.mode !== "sensitive" || !turn || wordAsked(phase.record, turn)) return phase;
    const due = (phase.record.questions ?? []).filter((question) => question.blocking && !question.answer && question.stage === phase.stage && now() - question.askedAt >= MACHINE_ANSWER_GRACE_MS);
    if (!due.length) return phase;
    const ids = new Set(due.map((question) => question.id));
    const questions = (phase.record.questions ?? []).map((question) => ids.has(question.id) ? { ...question, answer: MACHINE_STAGE_ANSWER, answeredBy: MACHINE_ANSWERER, answeredAt: now() } : question);
    for (const question of due) book(phase, "decisions", "answer", `${question.id}: ${MACHINE_ANSWERER} — ${MACHINE_STAGE_ANSWER}`);
    savePhase(db, phase.id, { record: { ...phase.record, questions }, at: now() });
    return mustGet(phase.id);
  }

  /**
   * A turn that waited only for the owner's word and no longer asks for it (owner.words changed, or a record from before 0.1.560 whose one
   * flag was recomputed): the step does what the method does when nothing is asked. A signed context goes to planning; an approved plan
   * whose gate holds is admitted (its grill rule included). A drawing waits for its next report as it does after a design yes.
   */
  async function lifted(phase: Phase): Promise<Phase> {
    const r = phase.record;
    if (phase.stage === "discussion" && r.context && !wordAsked(r, "context") && discussionGate(r).ok) {
      move(phase, "planning", r, "the context is signed and its turn asks no owner's word (owner.words: it touches no money, data or production deploy)");
      if (r.docFiles === true) await bestEffort(ctx.log, "phase spec write", writeGenerated(mustGet(phase.id), `${phaseFolder(phase.id)}/SPEC.md`, specText(mustGet(phase.id)), `phase ${phase.id}: SPEC.md`), null);
      return mustGet(phase.id);
    }
    if (phase.stage === "planning" && r.plan?.critique?.decision === "approve" && !r.plan.admittedSha && !wordAsked(r, "planning") && planGate(r).ok) {
      try { return await tools.admitIfReady(phase); } catch (cause) { if (cause instanceof PhaseRefusal) return mustGet(phase.id); throw cause; }
    }
    return phase;
  }

  /** Both, in order: the stage's due questions answered, then a wait that no longer applies lifted. */
  return { wordStep: async (phase: Phase): Promise<Phase> => lifted(machineAnswers(phase)) };
}
