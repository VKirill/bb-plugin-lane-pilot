import type { NodeExecutor, StepContext, Workflow, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { ServerCore } from "../../../contracts/server";
import { parseEvolveSettings } from "../../settings";
import { listHypotheses } from "../repositories/ledger-repository";
import { makeLogSink, readMergedSettings } from "../services/context";
import { decideHypothesis } from "../services/decide";
import {
  createModelCatalog,
  loadWorkflowForEvolve,
  runEvolveIngest,
  runEvolveReprove,
  str,
  type EvolveEventKind,
  type EvolveProveResult,
  type EvolveRouteMissLike,
  type EvolveRunVerdictLike,
  type EvolveWorkflowDeps,
} from "../services/evolve-loop";
import { proposeHypotheses } from "../services/hypotheses";
import { replayHypothesis } from "../services/replay";

export type {
  EvolveEventKind,
  EvolveProveResult,
  EvolveRouteMissLike,
  EvolveRunVerdictLike,
  EvolveWorkflowDeps,
};

/** Registers the five `lp.evolve_*` workflow action executors for the `lp.evolve` graph. */
export function registerEvolveActions(
  engine: WorkflowEngine,
  ctx: Pick<ServerCore, "db" | "bb" | "log"> & Partial<Pick<ServerCore, "manualMode">>,
  deps: EvolveWorkflowDeps = {},
): void {
  const log = makeLogSink({ bb: ctx.bb, log: ctx.log });
  const now = deps.now ?? (() => engine.now());

  const settingsOf = (projectId?: string | null) =>
    readMergedSettings({ db: ctx.db, projectId: projectId ?? GLOBAL_SETTINGS_PROJECT_ID, settings: deps.settings });

  const resolveWf = (id: string, version?: number): Workflow | null =>
    deps.resolveWorkflow?.(id, version)
    ?? deps.workflowEngine?.resolveWorkflow?.(id, version)
    ?? deps.loadBuiltinWorkflow?.(id)
    ?? null;

  const runStep = <T extends Record<string, unknown>>(
    stepName: string,
    handler: (step: StepContext) => Promise<T>,
  ): NodeExecutor => ({
    reentrant: true,
    run: async (step) => {
      try {
        return { output: await handler(step) };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        log.warn(`evolve handler failed step=${stepName}: ${message}`);
        throw cause;
      }
    },
  });

  engine.register("lp.evolve_ingest", runStep("ingest", (step) =>
    runEvolveIngest(ctx, deps, step.inputs, now()),
  ));

  engine.register("lp.evolve_propose", runStep("propose", async (step) => {
    const projectId = str(step.inputs.projectId) || null;
    const settings = settingsOf(projectId);
    const evolveCfg = parseEvolveSettings(settings);
    if (!evolveCfg.enabled) {
      return { skipped: "disabled", workflowId: "", hypothesisIds: [], replayCount: 0, demoteCount: 0 };
    }

    const workflowId = str(step.input.with.workflowId ?? step.inputs.workflowId);
    if (!workflowId || !evolveCfg.graphs.includes(workflowId)) {
      return { workflowId, hypothesisIds: [], replayCount: 0, demoteCount: 0 };
    }

    const loaded = await loadWorkflowForEvolve(ctx, deps, workflowId, projectId);
    await proposeHypotheses(
      {
        db: ctx.db,
        bb: ctx.bb as Parameters<typeof createModelCatalog>[0]["bb"],
        projectId,
        settings,
        log,
        ...(loaded ? { workflow: loaded as Workflow } : {}),
        loadWorkflow: async (id) => (await loadWorkflowForEvolve(ctx, deps, id, projectId)) as Workflow | null,
        ...(deps.leadRoad ? { leadRoad: deps.leadRoad } : {}),
        ...(deps.listRunVerdicts ? { listRunVerdicts: deps.listRunVerdicts } : {}),
        ...(deps.catalog !== undefined ? { catalog: deps.catalog } : {}),
        ...(deps.readCatalog ? { readCatalog: deps.readCatalog } : {}),
        ...(deps.generatePlan ? { generatePlan: deps.generatePlan } : {}),
        ...(deps.generateScript ? { generateScript: deps.generateScript } : {}),
        ...(deps.computeFingerprint ? { computeFingerprint: deps.computeFingerprint } : {}),
      },
      { workflowId, now: now() },
    );

    const queued = listHypotheses(ctx.db, { workflowId, state: "queued" });
    const replayCount = queued.filter((h) => h.source !== "fallback").length;
    const demoteCount = queued.filter((h) => h.source === "fallback").length;
    return { workflowId, hypothesisIds: queued.map((h) => h.id), replayCount, demoteCount };
  }));

  engine.register("lp.evolve_replay", runStep("replay", async (step) => {
    const projectId = str(step.inputs.projectId) || null;
    const settings = settingsOf(projectId);
    if (!parseEvolveSettings(settings).enabled) {
      return { skipped: "disabled", hypothesisId: "", passed: false, remaining: 0 };
    }

    const workflowId = str(step.input.with.workflowId ?? step.inputs.workflowId);
    const pending = listHypotheses(ctx.db, { ...(workflowId ? { workflowId } : {}), state: "queued" })
      .filter((h) => h.source !== "fallback");
    const target = pending[0];
    if (!target) {
      return { hypothesisId: "", passed: false, remaining: 0 };
    }

    const outcome = await replayHypothesis(
      { db: ctx.db, bb: ctx.bb, projectId, settings, log },
      {
        loadWorkflow: (id) => loadWorkflowForEvolve(ctx, deps, id, projectId),
        resolveWorkflow: resolveWf,
        now,
        ...deps.replayDeps,
      },
      { hypothesisId: target.id },
    );
    const remaining = listHypotheses(ctx.db, { ...(workflowId ? { workflowId } : {}), state: "queued" })
      .filter((h) => h.source !== "fallback").length;
    return { hypothesisId: target.id, passed: outcome.pass, remaining };
  }));

  engine.register("lp.evolve_decide", runStep("decide", async (step) => {
    const projectId = str(step.inputs.projectId) || null;
    const settings = settingsOf(projectId);
    if (!parseEvolveSettings(settings).enabled) {
      return { skipped: "disabled", decided: 0, modes: [] };
    }

    const workflowId = str(step.input.with.workflowId ?? step.inputs.workflowId);
    const replaying = listHypotheses(ctx.db, { ...(workflowId ? { workflowId } : {}), state: "replaying" });
    const demotions = listHypotheses(ctx.db, { ...(workflowId ? { workflowId } : {}), state: "queued" })
      .filter((h) => h.source === "fallback");
    const targets = [...demotions, ...replaying];

    const modes: string[] = [];
    for (const hyp of targets) {
      const res = await decideHypothesis(
        { db: ctx.db, bb: ctx.bb, projectId, settings, log, manualMode: ctx.manualMode },
        {
          loadWorkflow: (id) => loadWorkflowForEvolve(ctx, deps, id, projectId),
          resolveWorkflow: resolveWf,
          publishDraft: deps.evolvePublishDraft,
          rollbackDraft: deps.evolveRollbackDraft,
          getRunVerdict: deps.getRunVerdict,
          now,
          ...deps.decideDeps,
        },
        { hypothesisId: hyp.id },
      );
      modes.push(res.mode);
    }
    return { decided: targets.length, modes };
  }));

  engine.register("lp.evolve_reprove", runStep("reprove", (step) =>
    runEvolveReprove(ctx, deps, str(step.inputs.projectId) || null, now()),
  ));
}
