

import type { ArchitectApi, WorkflowLibraryApi } from "../../platform/server";
import { routeIntent } from "@lane-pilot/workflow-engine";
import { loadProjectSettings } from "../../storage";
import { taskSizeText } from "../../tasks";
import { medianTaskSize } from "../../rollback/server";
import { isRunHalted, isRunPaused } from "../../runs/server";
import { intakeRunGoals } from "../intake";
import { createAutoStages } from "./auto-stages";
import { anamnesisFor, ownerCardBlock } from "../../anamnesis";
import type { DriverBase } from "./driver-tools";
import type { Docs } from "./driver-docs";
import type { Journal } from "./driver-journal";
import type { Methods } from "./driver-methods";
import type { Steps } from "./driver-steps";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import { LoopHookRefusal, prepareLoopWorkflow } from "../../workflow";

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
  const library = services.workflowLibrary;
  const auto = createAutoStages(ctx, services, {
    exhausted: tools.exhaust,
    api: { context: tools.context, plan: tools.plan, planCheck: tools.planCheck, question: tools.question, waveReview: tools.waveReview, goalAudit: tools.goalAudit, lessons: tools.lessons, drawing: tools.drawing, returnTo: tools.returnTo,
      admitIfReady: async (phaseId: string) => { await tools.admitIfReady(tools.mustGet(phaseId)); } },
    get: tools.mustGet,
    save: (phaseId, record) => tools.savePhase(phaseId, { record, at: now() }),
    book: (phase, section, kind, text) => tools.book(phase, section as never, kind, text),
    writeDocs: tools.writeDocs,
    readText: tools.readText,
    planningHome: tools.planningHome,
    runtime: (phase) => (phase.runId ? { ctx, services, pmThreadId: phase.pmThreadId, projectId: phase.projectId, runId: phase.runId } : null),
    prepareWorkflow: async (phase, workflow) => {
      const loaded = await library.loadStore(phase.projectId);
      if (loaded.loopHooks?.error) throw new LoopHookRefusal(loaded.loopHooks.error);
      if (!loaded.loopHooks?.manifest) return { workflow, resolve: loaded.store.resolve };
      const prepared = prepareLoopWorkflow({ workflow, manifest: loaded.loopHooks.manifest, manifestSha256: loaded.loopHooks.sha256, resolve: loaded.store.resolve,
        status: (id, version) => { const item = loaded.store.get(id); return item && (version === undefined || item.workflow.version === version) ? { status: item.workflow.status, internal: item.workflow.internal, startedBy: item.workflow.startedBy } : null; } });
      return { workflow: prepared.workflow, resolve: prepared.resolve };
    },
    pmIdle: async (phase) => ((await orMiss(bb.sdk.threads.get({ threadId: phase.pmThreadId }), null, isNotFound)) as { status?: unknown } | null)?.status === "idle",
    now,
    medianTask: (phase) => { const m = medianTaskSize(db, phase.projectId); return m ? taskSizeText(m) : null; },
    runStopped: async (phase) => !!phase.runId && (await isRunHalted(bb.storage.kv as never, phase.runId) || await isRunPaused(bb.storage.kv as never, phase.runId)),
    proofCurrency: tools.proofCurrency,
    journal: (line) => tools.reactions.journalDrawing(line),
    ownerCard: () => ownerCardBlock(anamnesisFor(ctx).hub),
  });
  const architect = services.architect;
  // The small-task graph for a small job or a batch of fixes: started by the machine, not chosen by the PM.
  const train = {
    start: async (input: { projectId: string; pmThreadId: string; runId: string; requestId: string; text: string; kind: "small" | "batch" | "heavy" | "full"; path?: { size: string; risk: string } }) => {
      // A batch of independent fixes is one task per fix (issue-batch); a small job is one task (issue-quick); a heavy goal is the
      // full-lifecycle graph: analysis, plan, build in waves, review, browser check, the owner's acceptance, close.
      const settings = loadProjectSettings(db, input.projectId);
      const workflow = services.workflowEngine.resolveWorkflow(input.kind === "heavy" ? "full-lifecycle" : input.kind === "batch" ? "issue-batch" : input.kind === "full" ? "issue-full" : services.workflowLibrary.issueQuickWorkflowId(settings));
      if (!workflow) return null;
      const title = input.text.trim().split("\n").find((line) => line.trim())?.trim().slice(0, 120) ?? "Owner's request";
      try {
        const inputs = input.kind === "heavy" ? { goal: input.text.slice(0, 8000) } : { title, text: input.text.slice(0, 8000), ...(input.kind === "small" && input.path ? { size: input.path.size, risk: input.path.risk } : {}) };
        const loaded = await library.loadStore(input.projectId);
        if (loaded.loopHooks?.error) throw new LoopHookRefusal(loaded.loopHooks.error);
        const prepared = loaded.loopHooks?.manifest ? prepareLoopWorkflow({ workflow, manifest: loaded.loopHooks.manifest, manifestSha256: loaded.loopHooks.sha256, resolve: loaded.store.resolve,
          status: (id, version) => { const item = loaded.store.get(id); return item && (version === undefined || item.workflow.version === version) ? { status: item.workflow.status, internal: item.workflow.internal, startedBy: item.workflow.startedBy } : null; } }) : { workflow, resolve: loaded.store.resolve };
        const started = services.workflowEngine.start({ workflow: prepared.workflow, resolve: prepared.resolve, inputs, goals: intakeRunGoals(input.text), key: `intake:${input.pmThreadId}:${input.requestId}`,
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
