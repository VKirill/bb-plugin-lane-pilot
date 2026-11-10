import { scheduleIsolated } from "../../platform/server";
import { bindPhaseDesigns } from "../../tasks/server";
import { type ServerCore } from "../../contracts/server";
import { listPhases, listParts, resolvePhaseRef } from "../store";
import { acceptanceKey, observationDue, candidateOn, designGate, discussionGate, nextAction, openQuestions, planGate, planSignature, renderBook, wordOf, type Phase } from "../logic";
import { getRun, getRunWriterHost } from "../../storage";
import { hostContract } from "../../contracts";
import { runOnHost } from "@lane-pilot/host-calls";
import { bestEffort } from "@lane-pilot/kit";
import { createPhaseIntake } from "./intake";
import { recoverStopped } from "./auto-stages";
import type { PhaseReactions } from "./reactions";
import { installDocs } from "./driver-docs";
import { installJournal } from "./driver-journal";
import { installMethods } from "./driver-methods";
import { installSteps } from "./driver-steps";
import { installWiring } from "./driver-wiring";
import { PhaseRefusal, type DriverBase } from "./driver-tools";


import type { RegressionApi } from "../../baseline/server/regress";
import type { RollbackApi } from "../../rollback/server/rollback";
import type { RunGoalApi } from "../../run-goal/server/run-goal";
import type { WallLoopPort } from "../../contracts";
import type { ArchitectApi, DispatchWriter, ReadWriterWorkspaceFile, RecheckPlanFact, WorkflowEngineApi, WorkflowLibraryApi, WriterStateApi } from "../../platform/server";



import type { DocsNightlyApi } from "../../docs/server/docs-nightly";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  architect: ArchitectApi;
  dispatchWriter: DispatchWriter;
  docsPlaces: DocsNightlyApi["docsPlaces"];
  readWriterWorkspaceFile: ReadWriterWorkspaceFile;
  regression: RegressionApi;
  rollback: RollbackApi;
  recheckPlanFact: RecheckPlanFact;
  runBudgets: WriterStateApi["runBudgets"];
  runGoal: RunGoalApi;
  wall: WallLoopPort;
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowLibrary: WorkflowLibraryApi;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}

export { PhaseRefusal };
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
export function createPhaseDriver(ctx: ServerCore, services: Services, reactions: PhaseReactions) {
  const { db, bb } = ctx;
  const now = () => Date.now();
  /** When each closed phase was last read for rollbacks: the watch is a host git call, six hours apart is enough for a week's window. */
  const observedAt = new Map<string, number>();
  const OBSERVE_EVERY_MS = 6 * 3_600_000;
  // The task lint asks which drawings this run's phases confirmed (SMA ap_design_kin): the phase room answers it here.
  bindPhaseDesigns(db, (projectId, runId) => listPhases(db, { projectId, live: true }).filter((row) => row.runId === runId).map((row) => row.record.design));
  const base: DriverBase = { ctx, services, db, bb, now, reactions };
  const docs = installDocs(base);
  const journal = installJournal({ ...base, ...docs });
  const methods = installMethods({ ...base, ...docs, ...journal });
  const steps = installSteps({ ...base, ...docs, ...journal, ...methods });
  const { auto, train } = installWiring({ ...base, ...docs, ...journal, ...methods, ...steps });

  /** Idle pass (SMA dt_idle): when the pass takes nothing it says why — nothing to take, all waiting for the PM, or all at work. */
  async function tick(signal?: AbortSignal): Promise<{ moved: number; idle: string | null }> {
    let moved = 0;
    // A phase the machine stopped for a gap of its own goes on once a release closes the gap (not one a person stopped).
    for (const row of listPhases(db, { limit: 200 }).filter((candidate) => candidate.state === "stopped")) {
      const back = recoverStopped(row);
      if (!back) continue;
      docs.savePhase(row.id, { state: "active", record: back.record, at: now() });
      docs.book(row, "decisions", "resume_after_fix", back.note);
      moved += 1;
    }
    // Finish an accepted analysis (SMA p7_recover): a lesson the owner applied whose memory write did not land is written again, no new worker.
    for (const row of listPhases(db, { limit: 200 }).filter((candidate) => candidate.record.lessons?.draft?.state === "staged" && candidate.record.lessons.draft.error
      && wordOf(candidate.record, "lesson")?.decision === "yes")) journal.settleLesson(row, "yes");
    // The seven-day rollback watch (SMA p6_observe): closed phases are read for rollbacks of their work; the acceptance is untouched.
    for (const row of listPhases(db, { limit: 200 }).filter((candidate) => candidate.state === "closed" && candidate.closedAt && observationDue(candidate.closedAt, now(), candidate.record.observation))) {
      if (now() - (observedAt.get(row.id) ?? 0) < OBSERVE_EVERY_MS) continue;
      observedAt.set(row.id, now());
      try { await steps.observe(row); } catch (cause) { ctx.log(`phase ${row.id}: rollback watch failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    // Closed phases that have not finished their paperwork yet are driven once more.
    const unfinished = listPhases(db, { limit: 200 }).filter((row) => row.stage === "closed" && !row.record.closedDocs && Date.now() - row.updatedAt < 7 * 86_400_000);
    const live = listPhases(db, { live: true, limit: 100 });
    for (const phase of [...live, ...unfinished]) {
      if (signal?.aborted || ctx.isDisposed()) break;
      try {
        const after = await steps.finishClosed(await steps.drive(phase));
        if (after.stage !== phase.stage || after.state !== phase.state) moved += 1;
        // The machine drives the train: a stage it can run is not poked to the PM.
        if (!(await auto.step(docs.mustGet(after.id)))) await steps.poke(docs.mustGet(after.id));
        await docs.writeBook(docs.mustGet(after.id)).catch((cause: unknown) => ctx.log(`phase ${phase.id}: book not written: ${cause instanceof Error ? cause.message : String(cause)}`));
      } catch (cause) {
        ctx.log(`phase ${phase.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    const idle = moved > 0 ? null
      : !live.length ? "no live phase"
      : live.every((phase) => nextAction(phase, docs.facts(phase)).waitsForPm) ? "all live phases wait for the PM"
      : "all live phases at work";
    return { moved, idle };
  }

  function status(phaseId: string) {
    const phase = docs.mustGet(phaseId);
    const parts = listParts(db, phase.id);
    return { phase, next: nextAction(phase, docs.facts(phase)), gates: { discussion: discussionGate(phase.record), plan: planGate(phase.record), design: designGate(phase.record) }, book: renderBook(phase, parts), bookHead: parts.at(-1)?.hash ?? null, openQuestions: openQuestions(phase.record, phase.stage), ownerWord: { asked: !!phase.record.ownerWords, context: wordOf(phase.record, "context") ?? null, planning: wordOf(phase.record, "planning") ?? null, design: wordOf(phase.record, "design") ?? null, acceptance: wordOf(phase.record, "acceptance") ?? null, acceptanceKey: acceptanceKey(phase.record), designKey: phase.record.design?.drawing?.sha256 ?? null }, facts: Object.fromEntries(docs.facts(phase)) };
  }

  /**
   * The package the person decides on (SMA ta_view): the shown package key, the frozen verdict and the diffstat of the work —
   * `git diff --stat <baseSha>..<verdict.mainSha>` on the writer host (the candidate's tree before the landing), clipped.
   */
  async function acceptancePackage(phaseId: string) {
    const phase = docs.mustGet(phaseId);
    const verdict = phase.record.verification?.verdict;
    if (!verdict || phase.stage !== "acceptance") return null;
    const pkg: { key: string; verdict: { state: string; detail: string; mainSha: string | null }; diffStat: string | null } =
      { key: acceptanceKey(phase.record), verdict: { state: verdict.state, detail: verdict.detail, mainSha: verdict.mainSha }, diffStat: null };
    const run = phase.runId ? getRun(db, phase.runId) : null;
    const hostId = phase.runId ? getRunWriterHost(db, phase.runId) : null;
    const base = phase.record.execution?.baseSha;
    const cwd = candidateOn(phase.record) && !phase.record.candidate!.landedAt ? Object.values(phase.record.candidate!.trees)[0]?.path : run?.writer_workspace_path;
    if (hostId && base && verdict.mainSha && cwd) {
      const out = await bestEffort(ctx.log, "phase acceptance diffstat", runOnHost(bb.hosts.experimental_client({ contract: hostContract }), { hostId, cwd, command: `git diff --stat ${base}..${verdict.mainSha}`, timeoutSec: 30 }), null);
      if (out?.exitCode === 0) pkg.diffStat = out.stdout.trim().split("\n").slice(0, 40).join("\n").slice(0, 4000) || null;
    }
    return pkg;
  }

  /** Did the plan stay the admitted one (Plan unchanged since checking). */
  const planUnchanged = (phase: Phase) => !!phase.record.plan?.admittedSha && phase.record.plan.admittedSha === planSignature(phase.record.plan.items, phase.record.plan.contextSha);

  const phases = { open: methods.open, context: methods.context, plan: methods.plan, planCheck: methods.planCheck, drawing: methods.drawing, goalAudit: methods.goalAudit, lessons: methods.lessons, question: methods.question, answer: methods.answer, word: methods.word, waveReview: methods.waveReview, withdraw: methods.withdraw, revise: methods.revise, correct: methods.correct, returnTo: methods.returnTo, setState: methods.setState, stop: methods.stop, stopWave: methods.stopWave, compensate: methods.compensate, tick, drive: steps.drive, status, facts: docs.facts, planUnchanged, writeBook: docs.writeBook,
    acceptancePackage, resolve: (projectId: string | null | undefined, ref: string) => resolvePhaseRef(db, projectId, ref),
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
