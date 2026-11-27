import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import {
  wfChildRunStages,
  wfLastGoalAudit,
  wfRunRow,
  wfStepsOfRun,
  type RunRow,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import type { LeadRoadApi, RoadDb } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { createDraftStore, type DraftRow } from "../../../storage";
import { builtinWorkflow } from "../../builtin";
import {
  buildProjectTemplatePlan,
  parseJsonObject,
  type ProjectTemplateStage,
} from "../../models/project-template";
import { getRunVerdict } from "../repositories/run-verdict-repository";
import { createWorkflowArchitect, type WorkflowArchitect } from "./workflow-architect";

export type { ProjectTemplateStage };

export type ProjectTemplateDeps = {
  architect?: Pick<WorkflowArchitect, "createFrom"> | null;
  leadRoad?: Pick<LeadRoadApi, "addRoad" | "getRoad" | "listRoad"> | null;
  resolveWorkflow?: (id: string, version?: number) => Workflow | null;
  scope?: "global" | "project";
  now?: () => number;
};

export type ProjectTemplateResult =
  | { status: "created"; draftId: string; workflowId: string; stages: number }
  | { status: "near_twin"; workflowId: string; roadId: string | null; stages: number }
  | { status: "skipped"; reason: string };

type LogCtx = Pick<ServerCore, "db"> & Partial<Pick<ServerCore, "bb" | "log">>;

function logInfo(ctx: LogCtx, message: string): void {
  const bbLog = (ctx.bb as { log?: { info?: (msg: string) => void } } | undefined)?.log;
  if (bbLog?.info) bbLog.info(message);
  else ctx.log?.(message);
}

function logWarn(ctx: LogCtx, message: string): void {
  const bbLog = (ctx.bb as { log?: { warn?: (msg: string) => void } } | undefined)?.log;
  if (bbLog?.warn) bbLog.warn(message);
  else ctx.log?.(message);
}

function goalAuditPassed(
  db: LogCtx["db"],
  run: RunRow,
  steps: ReadonlyArray<Record<string, unknown>>,
  childIds: ReadonlyArray<{ id: string; workflow_id: string; status: string }>,
): boolean {
  const eventAudit = wfLastGoalAudit(db as never, run.id);
  if (eventAudit) return eventAudit.verdict === "pass";

  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    const nodeId = typeof step.node_id === "string" ? step.node_id : "";
    const stepKey = typeof step.step_key === "string" ? step.step_key : "";
    if (nodeId !== "goal_audit" && nodeId !== "goal-audit" && stepKey !== "$goal-audit") continue;
    if (step.state !== "succeeded") return false;
    const out = parseJsonObject(typeof step.output_json === "string" ? step.output_json : null);
    return out.verdict === "pass" || out.status === "pass" || out.all_met === true;
  }

  for (const child of childIds) {
    if (child.workflow_id !== "lp.close" || child.status !== "succeeded") continue;
    const childSteps = wfStepsOfRun(db as never, child.id);
    for (let i = childSteps.length - 1; i >= 0; i -= 1) {
      const step = childSteps[i]!;
      if (step.node_id !== "goal_audit" || step.state !== "succeeded") continue;
      const out = parseJsonObject(typeof step.output_json === "string" ? step.output_json : null);
      if (out.status === "pass" && out.all_met === true) return true;
    }
  }

  return false;
}

function existingTemplateDraftForRun(db: LogCtx["db"], projectId: string, runId: string): DraftRow | null {
  try {
    const drafts = createDraftStore(db as never).list(projectId, { limit: 200 });
    return drafts.find(
      (draft) =>
        draft.metadata?.source === "project-template" &&
        Array.isArray(draft.metadata.sourceRunIds) &&
        draft.metadata.sourceRunIds.includes(runId),
    ) ?? null;
  } catch {
    return null;
  }
}

function existingBranchRoadForRun(
  leadRoad: Pick<LeadRoadApi, "listRoad">,
  db: RoadDb,
  projectId: string | null,
  runId: string,
): string | null {
  try {
    const rows = leadRoad.listRoad(db, { projectId, kind: "option", limit: 200 });
    for (const row of rows) {
      if (row.class !== "branch" || !row.payload_json) continue;
      const payload = parseJsonObject(row.payload_json);
      if (payload.runId === runId || (Array.isArray(payload.sourceRunIds) && payload.sourceRunIds.includes(runId))) {
        return row.id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

const inflightByRun = new Map<string, Promise<ProjectTemplateResult>>();

/**
 * Extracts a `kind: "project"` workflow template draft from a finished, goal-audited, owner-accepted top-level project run.
 * On `near_twin` against an existing template, files a `class: "branch"` row on the lead road instead of creating a duplicate draft.
 */
export function extractProjectTemplateFromRun(
  ctx: LogCtx,
  deps: ProjectTemplateDeps,
  run: RunRow,
): Promise<ProjectTemplateResult> {
  if (!run || run.parent_run_id) return Promise.resolve({ status: "skipped", reason: "not_top_level" });
  const rawDef = parseJsonObject(run.definition_json);
  if (rawDef.kind !== "project") return Promise.resolve({ status: "skipped", reason: "not_project" });
  if (run.status !== "succeeded") return Promise.resolve({ status: "skipped", reason: "not_succeeded" });

  const inflight = inflightByRun.get(run.id);
  if (inflight) return inflight;

  const job = (async (): Promise<ProjectTemplateResult> => {
    const skip = (reason: string): ProjectTemplateResult => {
      logWarn(ctx, `project template skipped run=${run.id}: ${reason}`);
      return { status: "skipped", reason };
    };

    const steps = wfStepsOfRun(ctx.db as never, run.id);
    const childRuns = wfChildRunStages(ctx.db as never, run.id);

    if (!goalAuditPassed(ctx.db, run, steps, childRuns)) return skip("not audited");

    const verdict = getRunVerdict(ctx.db, run.id);
    if (!verdict) return skip("no verdict");
    if (verdict.verdict !== "accept") return skip(`verdict ${verdict.verdict}`);
    if (childRuns.length === 0) return skip("no children");

    const projectId = run.project_id?.trim() || GLOBAL_SETTINGS_PROJECT_ID;
    const existingDraft = existingTemplateDraftForRun(ctx.db, projectId, run.id);
    if (existingDraft) {
      return { status: "created", draftId: existingDraft.id, workflowId: existingDraft.workflowId, stages: childRuns.length };
    }
    if (deps.leadRoad) {
      const existingRoadId = existingBranchRoadForRun(deps.leadRoad, ctx.db as never, run.project_id?.trim() || null, run.id);
      if (existingRoadId) {
        return { status: "near_twin", workflowId: run.workflow_id, roadId: existingRoadId, stages: childRuns.length };
      }
    }
    if (!deps.architect?.createFrom) return skip("architect unavailable");

    const scope = deps.scope ?? "global";
    const resolveWorkflow = deps.resolveWorkflow ?? ((id: string, version?: number) => builtinWorkflow(id, version, ctx.db as never));
    const plan = buildProjectTemplatePlan({ run, rawDef, steps, childRuns, projectId, scope, resolveWorkflow });

    const created = await deps.architect.createFrom({
      projectId,
      scope,
      workflowId: plan.workflowId,
      definition: plan.definition,
      name: plan.name,
      description: plan.description,
      dedupe: true,
      metadata: plan.metadata,
    });

    if ("id" in created) {
      logInfo(ctx, `project template run=${run.id} stages=${plan.stages.length} draft=${created.id}`);
      return { status: "created", draftId: created.id, workflowId: created.workflowId, stages: plan.stages.length };
    }

    let roadId: string | null = null;
    if (deps.leadRoad) {
      const now = deps.now?.() ?? Date.now();
      const roadDb = ctx.db as never as RoadDb;
      const roadProjectId = run.project_id?.trim() || null;
      const rootId = roadProjectId ? `dir:${roadProjectId}` : "dir:global";
      const root = deps.leadRoad.getRoad(roadDb, rootId) ?? deps.leadRoad.addRoad(
        roadDb,
        {
          id: rootId,
          projectId: roadProjectId,
          title: roadProjectId ? `${roadProjectId}: directions` : "Above projects",
          kind: "direction",
          source: "lead",
          why: "the root the lead files a project's branches under when a proposal names no parent",
        },
        now,
      );
      const row = deps.leadRoad.addRoad(
        roadDb,
        {
          parentId: root.id,
          projectId: roadProjectId,
          title: `Branch template ${created.workflowId} (${run.workflow_id})`.slice(0, 300),
          kind: "option",
          source: "lead",
          class: "branch",
          why: `Finished accepted project run ${run.id} (${plan.stages.length} stage(s)) matches existing template ${created.workflowId} (${created.score.toFixed(2)} >= ${created.threshold}).`.slice(0, 2000),
          evidence: [{ kind: "run", ref: run.id, label: run.workflow_id }],
          payload: {
            key: `project-template-branch:${created.workflowId}:${run.id}`,
            kind: "project-template",
            graphId: created.workflowId,
            templateId: created.workflowId,
            runId: run.id,
            sourceRunIds: [run.id],
            score: created.score,
            threshold: created.threshold,
            stages: plan.stages.map((stage) => ({ workflowId: stage.workflowId, version: stage.version })),
          },
        },
        now,
      );
      roadId = row.id;
    }

    logInfo(ctx, `project template run=${run.id} stages=${plan.stages.length} draft=near_twin:${created.workflowId}`);
    return { status: "near_twin", workflowId: created.workflowId, roadId, stages: plan.stages.length };
  })().finally(() => {
    inflightByRun.delete(run.id);
  });

  inflightByRun.set(run.id, job);
  return job;
}

/** Looks up `runId` and runs `extractProjectTemplateFromRun`, returning `skipped` if the run does not exist. */
export async function extractProjectTemplate(
  ctx: LogCtx,
  deps: ProjectTemplateDeps,
  runId: string,
): Promise<ProjectTemplateResult> {
  const run = wfRunRow(ctx.db as never, runId);
  if (!run) return { status: "skipped", reason: "unknown_run" };
  return extractProjectTemplateFromRun(ctx, deps, run);
}

type ArchitectServiceBag = Parameters<typeof createWorkflowArchitect>[1];

/** Builds lazy run-finished and post-verdict handlers wired to `services` at call time. */
export function createProjectTemplateRunner(
  ctx: ServerCore,
  services: Partial<ArchitectServiceBag> & { leadRoad?: LeadRoadApi },
  deps: Omit<ProjectTemplateDeps, "architect" | "leadRoad"> & {
    architect?: ProjectTemplateDeps["architect"];
    leadRoad?: ProjectTemplateDeps["leadRoad"];
  } = {},
) {
  const resolveDeps = (): ProjectTemplateDeps => ({
    ...deps,
    architect: deps.architect ?? (services.workflowEngine ? createWorkflowArchitect(ctx, services as ArchitectServiceBag) : null),
    leadRoad: deps.leadRoad ?? services.leadRoad ?? null,
    resolveWorkflow: deps.resolveWorkflow ?? ((id, version) => services.workflowEngine?.resolveWorkflow(id, version) ?? builtinWorkflow(id, version, ctx.db)),
  });

  return {
    onRun: (run: RunRow) => extractProjectTemplateFromRun(ctx, resolveDeps(), run),
    onRunId: (runId: string) => extractProjectTemplate(ctx, resolveDeps(), runId),
  };
}
