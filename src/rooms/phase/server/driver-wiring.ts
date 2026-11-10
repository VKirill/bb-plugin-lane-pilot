

import type { ArchitectApi, WorkflowLibraryApi } from "../../platform/server";
import { routeIntent } from "@lane-pilot/workflow-engine";
import { loadProjectSettings } from "../../storage";
import { taskSizeText } from "../../tasks";
import { medianTaskSize } from "../../rollback/server";
import { isRunHalted, isRunPaused } from "../../runs/server";
import { intakeRunGoals } from "../intake";
import { createAutoStages } from "./auto-stages";
import type { DriverBase } from "./driver-tools";
import type { Docs } from "./driver-docs";
import type { Journal } from "./driver-journal";
import type { Methods } from "./driver-methods";
import type { Steps } from "./driver-steps";
import { isNotFound, orMiss } from "@lane-pilot/kit";

/** A sure route only: the hint takes a request away from the architect (the errand's api-recon bar, 0.1.412). */
const PUBLISHED_HINT_CONFIDENCE = 85;

/**
 * The driver's wiring to the machine around it: the automatic stages (the machine runs lp.analyze / lp.plan / lp.review / lp.close
 * itself and reports through the gates) and the small-task train (issue-quick / issue-batch / full-lifecycle, the workflow architect,
 * the published-graph router). It is orchestration's own assembly, kept apart from the state machine and the steps.
 */
export type WiringTools = DriverBase & Docs & Journal & Methods & Steps;
export function installWiring(tools: WiringTools) {
  const { ctx, services, db, bb, now } = tools;
  const auto = createAutoStages(ctx, services, {
    exhausted: tools.exhaust,
    api: { context: tools.context, plan: tools.plan, planCheck: tools.planCheck, question: tools.question, waveReview: tools.waveReview, goalAudit: tools.goalAudit, lessons: tools.lessons, drawing: tools.drawing, returnTo: tools.returnTo },
    get: tools.mustGet,
    save: (phaseId, record) => tools.savePhase(phaseId, { record, at: now() }),
    book: (phase, section, kind, text) => tools.book(phase, section as never, kind, text),
    writeDocs: tools.writeDocs,
    readText: tools.readText,
    runtime: (phase) => (phase.runId ? { ctx, services, pmThreadId: phase.pmThreadId, projectId: phase.projectId, runId: phase.runId } : null),
    pmIdle: async (phase) => ((await orMiss(bb.sdk.threads.get({ threadId: phase.pmThreadId }), null, isNotFound)) as { status?: unknown } | null)?.status === "idle",
    now,
    medianTask: (phase) => { const m = medianTaskSize(db, phase.projectId); return m ? taskSizeText(m) : null; },
    runStopped: async (phase) => !!phase.runId && (await isRunHalted(bb.storage.kv as never, phase.runId) || await isRunPaused(bb.storage.kv as never, phase.runId)),
    proofCurrency: tools.proofCurrency,
    journal: (line) => tools.reactions.journalDrawing(line),
  });
  const architect = services.architect;
  const library = services.workflowLibrary;
  // The small-task graph for a small job or a batch of fixes: started by the machine, not chosen by the PM.
  const train = {
    start: (input: { projectId: string; pmThreadId: string; runId: string; requestId: string; text: string; kind: "small" | "batch" | "heavy" | "full"; path?: { size: string; risk: string } }) => {
      // A batch of independent fixes is one task per fix (issue-batch); a small job is one task (issue-quick); a heavy goal is the
      // full-lifecycle graph: analysis, plan, build in waves, review, browser check, the owner's acceptance, close.
      const settings = loadProjectSettings(db, input.projectId);
      const workflow = services.workflowEngine.resolveWorkflow(input.kind === "heavy" ? "full-lifecycle" : input.kind === "batch" ? "issue-batch" : input.kind === "full" ? "issue-full" : services.workflowLibrary.issueQuickWorkflowId(settings));
      if (!workflow) return null;
      const title = input.text.trim().split("\n").find((line) => line.trim())?.trim().slice(0, 120) ?? "Owner's request";
      try {
        const inputs = input.kind === "heavy" ? { goal: input.text.slice(0, 8000) } : { title, text: input.text.slice(0, 8000), ...(input.kind === "small" && input.path ? { size: input.path.size, risk: input.path.risk } : {}) };
        const started = services.workflowEngine.start({ workflow, inputs, goals: intakeRunGoals(input.text), key: `intake:${input.pmThreadId}:${input.requestId}`,
          runtime: { ctx, services, pmThreadId: input.pmThreadId, projectId: input.projectId, runId: input.runId }, link: { projectId: input.projectId, runId: input.runId } });
        started.done.catch((cause: unknown) => ctx.log(`intake: ${workflow.id} ${started.runId} stopped: ${cause instanceof Error ? cause.message : String(cause)}`));
        return started.runId;
      } catch (cause) {
        ctx.log(`intake: ${workflow.id} did not start: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }
    },
    status: (wfRunId: string) => services.workflowEngine.get(wfRunId)?.status ?? null,
    startProcess: async (input: { projectId: string; pmThreadId: string; text: string }) => (await architect.startOrder(input)).threadId,
    // The router without a model (cheap, deterministic) over what lane_pilot_route reads: the project's graphs, else the built-in and global ones.
    findPublished: async (input: { projectId: string; text: string }) => {
      const store = await library.loadStore(input.projectId).then((loaded) => loaded.store, () => services.workflowCatalog.store());
      const routed = await routeIntent({ intent: input.text, workflows: store.list().map((item) => item.workflow), model: null });
      if (routed.decision !== "route" || !routed.workflowId || routed.confidence < PUBLISHED_HINT_CONFIDENCE) return null;
      const name = routed.candidates.find((card) => card.id === routed.workflowId)?.name ?? routed.workflowId;
      return { graphId: routed.workflowId, name, confidence: routed.confidence };
    },
  };
  return { auto, train };
}
