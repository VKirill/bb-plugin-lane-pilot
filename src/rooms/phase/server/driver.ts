import { scheduleIsolated, type ServerCore, type Services } from "../../core/server";
import { listPhases, listParts } from "../store";
import { acceptanceKey, designGate, discussionGate, nextAction, openQuestions, planGate, planSignature, renderBook, wordOf, type Phase } from "../logic";
import { createPhaseIntake } from "./intake";
import { recoverStopped } from "./auto-stages";
import { createPhaseReactions, DESIGN_JOURNAL, ROLE_LINES, type PhaseReactions } from "./reactions";
import { installDocs } from "./driver-docs";
import { installJournal } from "./driver-journal";
import { installMethods } from "./driver-methods";
import { installSteps } from "./driver-steps";
import { installWiring } from "./driver-wiring";
import { PhaseRefusal, type DriverTools } from "./driver-tools";

export { PhaseRefusal, DESIGN_JOURNAL, ROLE_LINES };
export type { PhaseReactions } from "./reactions";

/**
 * The phase driver: the machine above the PM (SMA map, Phase graph; Matvey Maslov 2026-10-22: «there is a machine above the orchestrator that
 * drives the route and at the turns switches the orchestrator on»). The PM reports what a stage produced (documents, a plan, a drawing, an
 * audit) with lane_pilot_phase; the driver checks every gate in code (logic.ts), records each decision in the phase book, issues the
 * plan's pieces wave by wave as tasks, runs the blind verification and the acceptance calculation itself, and sends the PM exactly one
 * instruction per turn. Every two minutes it looks at each live phase again.
 *
 * The driver is orchestration only: the state transitions live in `driver-methods.ts`, the step execution in `driver-steps.ts`, the
 * journal and the learning door in `driver-journal.ts`, the phase's own reads and book in `driver-docs.ts`, the machine around it in
 * `driver-wiring.ts`. The side effects on other rooms (learning, notices, metrics) are handed in as `reactions`.
 */
export function createPhaseDriver(ctx: ServerCore, services: Services, reactions: PhaseReactions = createPhaseReactions(ctx.db, ctx.bb)) {
  const { db, bb } = ctx;
  const now = () => Date.now();
  const tools = { ctx, services, db, bb, now, reactions } as DriverTools;
  Object.assign(tools, installDocs(tools));
  Object.assign(tools, installJournal(tools));
  Object.assign(tools, installMethods(tools));
  Object.assign(tools, installSteps(tools));
  const { auto, train } = installWiring(tools);

  async function tick(signal?: AbortSignal): Promise<number> {
    let moved = 0;
    // A phase the machine stopped for a gap of its own goes on once a release closes the gap (not one a person stopped).
    for (const row of listPhases(db, { limit: 200 }).filter((candidate) => candidate.state === "stopped")) {
      const back = recoverStopped(row);
      if (!back) continue;
      tools.savePhase(row.id, { state: "active", record: back.record, at: now() });
      tools.book(row, "decisions", "resume_after_fix", back.note);
      moved += 1;
    }
    // Finish an accepted analysis (SMA p7_recover): a lesson the owner applied whose memory write did not land is written again, no new worker.
    for (const row of listPhases(db, { limit: 200 }).filter((candidate) => candidate.record.lessons?.draft?.state === "staged" && candidate.record.lessons.draft.error
      && wordOf(candidate.record, "lesson")?.decision === "yes")) tools.settleLesson(row, "yes");
    // Closed phases that have not finished their paperwork yet are driven once more.
    const unfinished = listPhases(db, { limit: 200 }).filter((row) => row.stage === "closed" && !row.record.closedDocs && Date.now() - row.updatedAt < 7 * 86_400_000);
    for (const phase of [...listPhases(db, { live: true, limit: 100 }), ...unfinished]) {
      if (signal?.aborted || ctx.isDisposed()) break;
      try {
        const after = await tools.finishClosed(await tools.drive(phase));
        if (after.stage !== phase.stage || after.state !== phase.state) moved += 1;
        // The machine drives the train: a stage it can run is not poked to the PM.
        if (!(await auto.step(tools.mustGet(after.id)))) await tools.poke(tools.mustGet(after.id));
        await tools.writeBook(tools.mustGet(after.id)).catch((cause: unknown) => ctx.log(`phase ${phase.id}: book not written: ${cause instanceof Error ? cause.message : String(cause)}`));
      } catch (cause) {
        ctx.log(`phase ${phase.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return moved;
  }

  function status(phaseId: string) {
    const phase = tools.mustGet(phaseId);
    const parts = listParts(db, phase.id);
    return { phase, next: nextAction(phase, tools.facts(phase)), gates: { discussion: discussionGate(phase.record), plan: planGate(phase.record), design: designGate(phase.record) }, book: renderBook(phase, parts), bookHead: parts.at(-1)?.hash ?? null, openQuestions: openQuestions(phase.record, phase.stage), ownerWord: { asked: !!phase.record.ownerWords, context: wordOf(phase.record, "context") ?? null, planning: wordOf(phase.record, "planning") ?? null, design: wordOf(phase.record, "design") ?? null, acceptance: wordOf(phase.record, "acceptance") ?? null, acceptanceKey: acceptanceKey(phase.record) }, facts: Object.fromEntries(tools.facts(phase)) };
  }

  /** Did the plan stay the admitted one (Plan unchanged since checking). */
  const planUnchanged = (phase: Phase) => !!phase.record.plan?.admittedSha && phase.record.plan.admittedSha === planSignature(phase.record.plan.items, phase.record.plan.contextSha);

  const phases = { open: tools.open, context: tools.context, plan: tools.plan, planCheck: tools.planCheck, drawing: tools.drawing, goalAudit: tools.goalAudit, lessons: tools.lessons, question: tools.question, answer: tools.answer, word: tools.word, waveReview: tools.waveReview, withdraw: tools.withdraw, revise: tools.revise, correct: tools.correct, returnTo: tools.returnTo, setState: tools.setState, stop: tools.stop, stopWave: tools.stopWave, compensate: tools.compensate, tick, drive: tools.drive, status, facts: tools.facts, planUnchanged, writeBook: tools.writeBook,
    list: (filter: Parameters<typeof listPhases>[1]) => listPhases(db, filter) };
  return { phases, phaseIntake: createPhaseIntake(ctx, phases, train) };
}
export type PhaseApi = ReturnType<typeof createPhaseDriver>["phases"];

export function mountPhaseDriver(ctx: ServerCore, api: PhaseApi): void {
  scheduleIsolated(ctx.bb, "phase-drive", "*/2 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.tick(signal).catch((cause: unknown) => ctx.log(`phase drive failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 30 * 60_000 });
}
