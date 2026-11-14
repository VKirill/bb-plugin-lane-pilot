import { phaseWordItemKey } from "./word-item";
import { isWholeConsent } from "../../tasks";
import { bestEffort } from "@lane-pilot/kit";
import { PHASE_STAGES, acceptanceKey, discussionGate, phaseFolder, wordAsked, wordKeyOf } from "../logic";
import { specText, uatState } from "../stages";
import { savePhase } from "../store";
import { PhaseRefusal } from "./driver-tools";
import type { MethodsTools } from "./driver-methods";
import type { ReturnToInput } from "./driver-methods-control";
import type { Phase, PhaseRecord, PhaseStage, WordTurn } from "../logic";

type Reported = { phaseId: string; by?: string };
export type QuestionInput = Reported & { text: string; blocking: boolean };
export type AnswerInput = Reported & { questionId: string; answer: string };
export type WordInput = Reported & { turn: WordTurn; decision: "yes" | "no"; text: string; wave?: number; useful?: boolean; limits?: boolean; key?: string };
export type WaveReviewInput = Reported & { wave: number; state: "passed" | "failed"; by: string; summary: string };

/** Questions to the owner and the words that answer them: question and answer rows, the owner's word at a turn, and the wave review. */
export function installWordMethods(tools: MethodsTools, deps: { returnTo: (input: ReturnToInput) => Phase; admitIfReady: (phase: Phase) => Promise<Phase> }) {
  const { ctx, db, now, reactions } = tools;
  const { mustGet, book, move, readText, writeGenerated } = tools;
  const { returnTo, admitIfReady } = deps;

  function question(input: QuestionInput): Phase {
    const phase = mustGet(input.phaseId);
    const id = `q${(phase.record.questions?.length ?? 0) + 1}`;
    const record: PhaseRecord = { ...phase.record, questions: [...(phase.record.questions ?? []), { id, stage: phase.stage, text: input.text.slice(0, 1000), blocking: input.blocking, askedAt: now() }] };
    book(phase, phase.stage === "planning" ? "plan" : "decisions", "question", `${id}${input.blocking ? " (blocking)" : ""}: ${input.text}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }

  function answer(input: AnswerInput): Phase {
    const phase = mustGet(input.phaseId);
    const questions = phase.record.questions ?? [];
    if (!questions.some((row) => row.id === input.questionId)) throw new PhaseRefusal(`no question ${input.questionId}`);
    const record: PhaseRecord = { ...phase.record, questions: questions.map((row) => row.id === input.questionId ? { ...row, answer: input.answer.slice(0, 2000), answeredBy: input.by ?? "pm", answeredAt: now() } : row) };
    book(phase, "decisions", "answer", `${input.questionId}: ${input.answer}`);
    savePhase(db, phase.id, { record, at: now() });
    return mustGet(phase.id);
  }
  /** The owner's word at a turn (owner.words on). «no» sends the phase back: from planning or design to planning, from acceptance to execution. */
  async function word(input: WordInput): Promise<Phase> {
    const phase = await tools.freshTurns(mustGet(input.phaseId));
    // Keyed decision on the phase (SMA p6_decide): two decisions under the key of the shown package.
    if (input.turn === "acceptance" && input.decision === "yes" && !(input.useful === true && input.limits === true))
      throw new PhaseRefusal("the acceptance is two decisions: the result is clear and useful (useful:true) and the remaining limits and recovery are acknowledged (limits:true); a «no» to either is decision no with the words why");
    // The yes is for the package that was shown (SMA p6_decide, p6_stale): the caller names its key, and a package that changed since
    // is not signed by it (SMA audit N-02: the key was taken at write time, so a click on package A signed package B).
    // The design yes signs the drawing it was shown (SMA tb_design_gate_confirmed): without the drawing's hash, or over
    // an older edition, it is refused — a redrawn drawing needs a new yes.
    const drawingSha = phase.record.design?.drawing?.sha256 ?? null;
    if (input.turn === "design" && input.decision === "yes" && wordAsked(phase.record, "design") && input.key !== drawingSha)
      throw new PhaseRefusal(`the design yes names the hash of the drawing the owner was shown (status ownerWord.designKey, now ${drawingSha ?? "none"})`);
    const shownKey = acceptanceKey(phase.record);
    if (input.turn === "acceptance" && input.decision === "yes" && !input.key) throw new PhaseRefusal(`the acceptance yes names the key of the package the owner was shown (status ownerWord.acceptanceKey, now ${shownKey})`);
    if (input.turn === "acceptance" && input.decision === "yes" && input.key !== shownKey) throw new PhaseRefusal(`the package changed since it was shown (shown ${input.key}, now ${shownKey}): show the acceptance again and ask anew`);
    // The planning yes is for the proposal shown (SMA m_ce_proposal): a yes that names a key counts only for the plan with
    // that key (the PM takes it from status ownerWord.planKey); a yes without one is for the plan in the record now and is
    // stored with its key, so the owner's button keeps working. A project that sets phase.proposal_ttl_hours also refuses
    // a yes on a proposal older than that; unset there is no term — the owner often answers a day later.
    if (input.turn === "planning" && input.decision === "yes" && wordAsked(phase.record, "planning") && phase.record.plan) {
      const plan = phase.record.plan;
      const settings = await ctx.effectiveProjectSettings(phase.projectId).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>));
      const ttlHours = Number(settings["phase.proposal_ttl_hours"] ?? NaN);
      if (plan.submittedAt && Number.isFinite(ttlHours) && ttlHours > 0 && now() - plan.submittedAt > ttlHours * 3_600_000) {
        throw new PhaseRefusal(`the proposal is stale (submitted ${Math.round((now() - plan.submittedAt) / 3_600_000)} h ago, phase.proposal_ttl_hours ${ttlHours}): show the plan again and ask anew`);
      }
      if (input.key && input.key !== plan.sha) throw new PhaseRefusal(`the plan changed since it was shown (shown ${input.key}, now ${plan.sha}): show the plan again and ask anew`);
    }
    // Consent is the whole message: «да» alone is consent; «да, но …» is a new word that goes back as words, not as yes.
    if (input.decision === "yes" && !isWholeConsent(input.text) && !/^owner via (screen|cli)$/.test(input.by ?? "")) throw new PhaseRefusal("the owner's message is not a whole consent: «да, но …» is a new word — record it as decision no with his words, or ask again");
    if (input.turn === "uat" && input.decision === "yes") {
      // Session complete (SMA p5_uat_line): the owner's yes counts only when every UAT line of the record is passed.
      const lines = phase.record.uat?.lines;
      if (lines) {
        const open = lines.filter((row) => row.state === "open"), failed = lines.filter((row) => row.state === "failed");
        if (open.length || failed.length || !lines.length) throw new PhaseRefusal(`UAT is not complete: ${open.length} open, ${failed.length} failed of ${lines.length} — the owner answers each line by its number (uat_line)`);
      } else {
        // A UAT written before the record lines existed: fall back to the checkboxes of UAT.md.
        const path = phase.record.uat?.path;
        const text = path ? await readText(phase, path) : null;
        const state = text ? uatState(text) : null;
        if (!state || !state.lines || state.open.length || state.failed.length) throw new PhaseRefusal(`UAT is not complete: ${!state ? "no UAT.md" : `${state.open.length} open, ${state.failed.length} failed of ${state.lines}`} — the owner marks each line in ${path ?? "UAT.md"} first`);
      }
    }
    // A yes at planning, design or issue signs what was shown (the plan, the drawing) under its key, like the acceptance's
    // (sma as_launchable): what changes after the word launches nothing on it.
    const consentKey = input.turn !== "acceptance" && input.decision === "yes" ? wordKeyOf(phase.record, input.turn) : null;
    const record: PhaseRecord = { ...phase.record, words: [...(phase.record.words ?? []), { turn: input.turn, decision: input.decision, by: input.by ?? "owner", text: input.text.slice(0, 2000), at: now(), ...(input.wave !== undefined ? { wave: input.wave } : {}),
      // SMA pc_contract: the version this word signs, so a new version of the context, the plan or the drawing cannot pass on it.
      ...(input.turn === "context" && phase.record.context ? { sha: phase.record.context.sha } : {}),
      ...(input.turn === "planning" && phase.record.plan ? { sha: phase.record.plan.sha, key: phase.record.plan.sha } : {}),
      ...(input.turn === "design" ? { ...(phase.record.design?.drawing ? { sha: phase.record.design.drawing.sha256 } : {}), key: drawingSha ?? undefined } : {}),
      // The issue yes signs the plan it launches (sma as_launchable).
      ...(input.turn === "issue" && consentKey ? { key: consentKey } : {}),
      ...(input.turn === "acceptance" ? { useful: input.useful === true, limits: input.limits === true, key: shownKey } : {}) }] };
    reactions.answerPhaseWord(phase.id, input.turn, input.wave, input.decision, input.text, input.by ?? "owner");
    reactions.closeOwnerItem(phaseWordItemKey(phase.id, input.turn, input.wave), input.by ?? "owner");
    book(phase, "decisions", `word_${input.turn}`, `${input.by ?? "owner"}: ${input.decision} — ${input.text}`);
    if (input.turn === "design") await reactions.noteDesignWord(phase.id, input.decision);
    savePhase(db, phase.id, { record, at: now() });
    if (input.turn === "lesson") { tools.settleLesson(mustGet(phase.id), input.decision); return mustGet(phase.id); }
    if (input.turn === "context") {
      if (phase.stage !== "discussion" || !record.context) return mustGet(phase.id);
      // The owner signs the context, or says no: then it is unsigned and the discussion goes on with his words in the book.
      if (input.decision === "no") { savePhase(db, phase.id, { record: { ...record, context: undefined }, at: now() }); return mustGet(phase.id); }
      if (discussionGate(record).ok) {
        move(phase, "planning", record, "the owner signed the context");
        if (record.docFiles === true) await bestEffort(ctx.log, "phase spec write", writeGenerated(mustGet(phase.id), `${phaseFolder(phase.id)}/SPEC.md`, specText(mustGet(phase.id)), `phase ${phase.id}: SPEC.md`), null);
      }
      return mustGet(phase.id);
    }
    // Drawing feedback (SMA ts_feedback): the owner's «no» on a drawing keeps his remark against that exact edition, archives
    // it and clears the drawing, so lp.draw redraws it with the remark — the phase stays at design.
    if (input.turn === "design" && input.decision === "no" && phase.stage === "design" && phase.record.design?.drawing) {
      const design = phase.record.design;
      const drawing = design.drawing!;
      const designRecord: NonNullable<PhaseRecord["design"]> = { ...design, drawing: undefined,
        archived: [...(design.archived ?? []), drawing].slice(-10),
        feedback: [...(design.feedback ?? []), { drawingSha: drawing.sha256, text: input.text.slice(0, 2000), by: input.by ?? "owner", at: now() }].slice(-20) };
      savePhase(db, phase.id, { record: { ...record, design: designRecord }, at: now() });
      book(phase, "design", "drawing_returned", `the owner returned drawing ${drawing.sha256.slice(0, 12)}: ${input.text.slice(0, 300)} — it is redrawn with the remark`);
      return mustGet(phase.id);
    }
    if (input.decision === "no") {
      const to: PhaseStage = input.turn === "acceptance" || input.turn === "uat" ? "execution" : "planning";
      if (PHASE_STAGES.indexOf(to) < PHASE_STAGES.indexOf(phase.stage)) return returnTo({ phaseId: phase.id, to, note: `the owner said no at ${input.turn}: ${input.text}`, by: input.by ?? "owner" });
    }
    if (input.decision === "yes" && phase.stage === "planning" && input.turn === "planning") return admitIfReady(mustGet(phase.id));
    return mustGet(phase.id);
  }

  /** Wave verified by another model: the PM reports the review of a finished wave; a failed one returns the phase to execution's fixes. */
  function waveReview(input: WaveReviewInput): Phase {
    const phase = mustGet(input.phaseId);
    const waves = { ...(phase.record.execution?.waves ?? {}) };
    const done = waves[String(input.wave)];
    if (!done) throw new PhaseRefusal(`wave ${input.wave} is not finished yet`);
    waves[String(input.wave)] = { ...done, review: { state: input.state, by: input.by, summary: input.summary.slice(0, 2000), at: now() } };
    book(phase, "execution", `wave_${input.state}`, `wave ${input.wave} reviewed by ${input.by}: ${input.state} — ${input.summary}`);
    savePhase(db, phase.id, { record: { ...phase.record, execution: { ...phase.record.execution!, waves } }, at: now() });
    return mustGet(phase.id);
  }

  return { question, answer, word, waveReview };
}
