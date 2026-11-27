import { redactKnown } from "@lane-pilot/kit";
import {
  DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
  DEFAULT_PATHS_BRANCH_WINDOW_DAYS,
  GLOBAL_SETTINGS_PROJECT_ID,
  PATHS_BRANCH_DRAFT_REPEATS_KEY,
  PATHS_BRANCH_WINDOW_DAYS_KEY,
} from "@lane-pilot/settings-catalog";
import {
  TERMINAL_RUN,
  branchCandidateKey,
  graphSignature,
  listRunIdsByWorkflowAndThreads,
  wfNextRunCreatedAt,
  wfRunRow,
  wfStepsOfRun,
  type RawDefinition,
  type RunRow,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { listTrajectoryDeltasForRunSafe, type TrajectoryDeltaStoredRow } from "../../../platform/server";
import { listErrandEpisodeTraces, loadProjectSettings } from "../../../storage";
import { builtinWorkflow, isEvolvableDomainBuiltinId } from "../../builtin";
import { getRunVerdict } from "../repositories/run-verdict-repository";
import { buildBranchSaveBrief, buildPathSaveBrief } from "../../models/path-save-brief";
import type { WorkflowArchitect } from "./workflow-architect";

export { buildBranchSaveBrief, buildPathSaveBrief };

const DAY_MS = 86_400_000;
const DESCRIPTION_MAX = 2000;

export type LoadedWorkflowSource = {
  workflow: Workflow;
  origin?: "builtin" | "global" | "project";
  path?: string;
  fileSha256?: string | null;
};

export type SavePathInput = {
  runId: string;
  note?: string;
  projectId: string;
  threadId?: string;
};

export type SaveBranchInput = {
  graphId: string;
  candidateKey: string;
  projectId?: string;
  threadId?: string;
  note?: string;
  now?: number;
  windowDays?: number;
  repeats?: number;
};

export type SavePathDeps = {
  architect?: (Pick<WorkflowArchitect, "create"> & Partial<Pick<WorkflowArchitect, "createFrom">>) | null;
  listInterventions?: (input: {
    projectId?: string | null;
    workflowId?: string | null;
    threadId?: string | null;
    since?: number;
    until?: number;
    onlyAccepted?: boolean;
    limit?: number;
  }) => TrajectoryDeltaStoredRow[];
  loadWorkflow?: (
    graphId: string,
    projectId?: string,
  ) => Promise<LoadedWorkflowSource | Workflow | null> | LoadedWorkflowSource | Workflow | null;
  windowDays?: number;
  repeats?: number;
};

export type SavePathResult =
  | { ok: true; draftId: string }
  | {
      ok: false;
      reason: "run_not_finished" | "no_trace" | "near_twin" | "architect_unavailable";
      workflowId?: string;
      suggestion?: "branch";
    };

export type SaveBranchResult =
  | { ok: true; draftId: string }
  | {
      ok: false;
      reason: "unknown_graph" | "candidate_not_found" | "not_ready" | "near_twin" | "architect_unavailable";
      workflowId?: string;
    };

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function goalFromRun(run: RunRow, inputs: Record<string, unknown>): string {
  for (const key of ["title", "task", "brief", "request", "intent", "goal", "query"]) {
    const val = inputs[key];
    if (typeof val === "string" && val.trim()) {
      return redactKnown(val.trim()).replace(/\s+/g, " ");
    }
  }
  return run.workflow_id;
}

function draftNameFromGoal(goal: string): string {
  const cleaned = goal.trim().replace(/\s+/g, " ");
  if (!cleaned) return "Saved path";
  return cleaned.length > 80 ? `${cleaned.slice(0, 77).trimEnd()}...` : cleaned;
}

function readEpisodeTrace(ctx: LogCtx, runId: string): string[] {
  try {
    const raw = listErrandEpisodeTraces(ctx.db, [runId]).get(runId);
    if (!raw || !raw.trim()) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed) out.push(trimmed);
      } else if (isRecord(item) && typeof item.tool === "string" && item.tool.trim()) {
        out.push(item.tool.trim());
      }
    }
    return out;
  } catch {
    return [];
  }
}

function definitionNodesById(definitionJson: string): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const def = parseJsonObject(definitionJson);
  const nodes = Array.isArray(def.nodes) ? def.nodes : [];
  for (const item of nodes) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) continue;
    map.set(item.id, item);
  }
  return map;
}

function stepSignatureEntry(node: Record<string, unknown> | undefined, step: Record<string, unknown>): string {
  if (node && typeof node.type === "string" && node.type) {
    const type = node.type.trim();
    const id =
      (type === "subworkflow" && typeof node.workflow === "string" && node.workflow.trim())
      || ((type === "agent" || type === "human") && typeof node.role === "string" && node.role.trim())
      || (typeof node.uses === "string" && node.uses.trim())
      || (typeof node.action === "string" && node.action.trim())
      || String(step.node_id);
    return `${type}:${id}`;
  }
  const receipt = parseJsonObject(typeof step.receipt_json === "string" ? step.receipt_json : null);
  const executor = typeof receipt.executor === "string" && receipt.executor.trim() ? receipt.executor.trim() : null;
  return `action:${executor ?? String(step.node_id)}`;
}

function outputFieldNames(outputJson: unknown): string[] {
  if (typeof outputJson !== "string" || !outputJson.trim()) return [];
  const parsed = parseJsonObject(outputJson);
  return Object.keys(parsed);
}

type TraceData = {
  stepLines: string[];
  dedupeTrace: string[];
  signature?: ReadonlySet<string>;
};

function extractTraceData(ctx: LogCtx, run: RunRow): TraceData | null {
  const episodeTrace = readEpisodeTrace(ctx, run.id);
  const steps = wfStepsOfRun(ctx.db, run.id);

  if (episodeTrace.length > 0) {
    const stepFieldsByNode = new Map<string, string[]>();
    const allStepFields: string[] = [];
    for (const step of steps) {
      const nodeId = typeof step.node_id === "string" ? step.node_id : "";
      const fields = outputFieldNames(step.output_json);
      if (fields.length) {
        if (nodeId) stepFieldsByNode.set(nodeId, fields);
        for (const f of fields) if (!allStepFields.includes(f)) allStepFields.push(f);
      }
    }
    const stepLines = episodeTrace.map((entry, idx) => {
      const colonIdx = entry.indexOf(":");
      const tail = colonIdx >= 0 ? entry.slice(colonIdx + 1) : entry;
      const fields = stepFieldsByNode.get(entry) ?? stepFieldsByNode.get(tail) ?? (idx === episodeTrace.length - 1 ? allStepFields : []);
      return fields.length ? `${idx + 1}. ${entry} (outputs: ${fields.join(", ")})` : `${idx + 1}. ${entry}`;
    });
    return { stepLines, dedupeTrace: episodeTrace };
  }

  if (run.workflow_id === "errand") return null;

  const executedSteps = steps.filter((step) => step.state !== "skipped" && step.state !== "pending");
  const sourceSteps = executedSteps.length ? executedSteps : steps;
  if (sourceSteps.length === 0) return null;

  const nodesById = definitionNodesById(run.definition_json);
  const dedupeTrace: string[] = [];
  const executedNodes: Record<string, unknown>[] = [];
  const stepLines: string[] = [];

  for (let i = 0; i < sourceSteps.length; i += 1) {
    const step = sourceSteps[i]!;
    const nodeId = typeof step.node_id === "string" ? step.node_id : `step_${i + 1}`;
    const node = nodesById.get(nodeId);
    if (node) executedNodes.push(node);
    const traceEntry = stepSignatureEntry(node, step);
    dedupeTrace.push(traceEntry);
    const fields = outputFieldNames(step.output_json);
    stepLines.push(
      fields.length
        ? `${i + 1}. ${nodeId} [${traceEntry}] (outputs: ${fields.join(", ")})`
        : `${i + 1}. ${nodeId} [${traceEntry}]`,
    );
  }

  const signature = executedNodes.length ? graphSignature({ nodes: executedNodes } as RawDefinition) : undefined;
  return { stepLines, dedupeTrace, ...(signature && signature.size > 0 ? { signature } : {}) };
}

/**
 * Captures a finished top-level workflow or errand run as a workflow draft with `source: "path-capture"`
 * and `sourceRunIds: [runId]`, passing through the structural dedup gate.
 */
export async function savePath(
  ctx: LogCtx,
  deps: SavePathDeps,
  input: SavePathInput,
): Promise<SavePathResult> {
  const runId = input.runId.trim();
  const refuse = (
    reason: "run_not_finished" | "no_trace" | "near_twin" | "architect_unavailable",
    extra?: { workflowId?: string; suggestion?: "branch" },
  ): SavePathResult => {
    logWarn(ctx, `path save refused run=${runId || "unknown"}: ${reason}`);
    return { ok: false, reason, ...extra };
  };

  if (!runId) return refuse("no_trace");
  const run = wfRunRow(ctx.db, runId);
  if (!run) return refuse("no_trace");
  if (run.project_id && input.projectId && run.project_id !== input.projectId) return refuse("no_trace");
  if (run.parent_run_id !== null || !TERMINAL_RUN.includes(run.status)) return refuse("run_not_finished");

  const traceData = extractTraceData(ctx, run);
  if (!traceData) return refuse("no_trace");

  if (!deps?.architect) return refuse("architect_unavailable");

  const inputs = parseJsonObject(run.inputs_json);
  const goal = goalFromRun(run, inputs);
  const nextRunAt = wfNextRunCreatedAt(ctx.db, run.workflow_id, run.project_id, run.created_at);
  const interventionFilter = {
    projectId: run.project_id,
    workflowId: run.workflow_id,
    threadId: input.threadId ?? null,
    since: run.created_at,
    ...(nextRunAt !== undefined ? { until: nextRunAt } : {}),
  };
  const interventions = deps.listInterventions
    ? deps.listInterventions(interventionFilter)
    : listTrajectoryDeltasForRunSafe(ctx.db, interventionFilter, {
        log: { warn: (msg) => logWarn(ctx, msg) },
      });
  const verdict = getRunVerdict(ctx.db, runId);
  const brief = buildPathSaveBrief({
    goal,
    stepLines: traceData.stepLines,
    interventions,
    verdict,
    note: input.note,
  });

  const description = brief.length > DESCRIPTION_MAX ? `${brief.slice(0, DESCRIPTION_MAX - 3).trimEnd()}...` : brief;
  const projectId = input.projectId || run.project_id || "";
  const created = await deps.architect.create({
    projectId,
    threadId: input.threadId ?? "",
    name: draftNameFromGoal(goal),
    description,
    scope: "project",
    dedupe: true,
    trace: traceData.dedupeTrace,
    ...(traceData.signature ? { signature: traceData.signature } : {}),
    metadata: {
      source: "path-capture",
      sourceRunIds: [runId],
      brief,
      ...(verdict ? { sourceVerdict: verdict.verdict } : {}),
      ...(input.note?.trim() ? { note: redactKnown(input.note.trim()) } : {}),
    },
  });

  if (!("draftId" in created)) {
    return refuse("near_twin", { workflowId: created.workflowId, suggestion: "branch" });
  }

  logInfo(ctx, `path save run=${runId} draft=${created.draftId}`);
  return { ok: true, draftId: created.draftId };
}

function readBranchSettings(db: LogCtx["db"]): { windowDays: number; repeats: number } {
  try {
    const raw = loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID);
    const w = Number(raw[PATHS_BRANCH_WINDOW_DAYS_KEY]);
    const r = Number(raw[PATHS_BRANCH_DRAFT_REPEATS_KEY]);
    return {
      windowDays: Number.isFinite(w) && w >= 1 ? Math.round(w) : DEFAULT_PATHS_BRANCH_WINDOW_DAYS,
      repeats: Number.isFinite(r) && r >= 1 ? Math.round(r) : DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
    };
  } catch {
    return { windowDays: DEFAULT_PATHS_BRANCH_WINDOW_DAYS, repeats: DEFAULT_PATHS_BRANCH_DRAFT_REPEATS };
  }
}

async function resolveLoadedWorkflow(
  deps: SavePathDeps,
  graphId: string,
  projectId?: string,
): Promise<LoadedWorkflowSource | null> {
  if (deps.loadWorkflow) {
    const found = await deps.loadWorkflow(graphId, projectId);
    if (!found) return null;
    return "workflow" in found ? found : { workflow: found };
  }
  const wf = builtinWorkflow(graphId);
  return wf ? { workflow: wf, origin: "builtin" } : null;
}

/**
 * Opens a branch draft seeded from `graphId` for a repeated trajectory-delta candidate,
 * exempting `graphId` from structural dedup and binding the candidate's runs as `sourceRunIds`.
 */
export async function saveBranch(
  ctx: LogCtx,
  deps: SavePathDeps,
  input: SaveBranchInput,
): Promise<SaveBranchResult> {
  const graphId = input.graphId.trim();
  const candidateKey = input.candidateKey.trim();
  const refuse = (
    reason: "unknown_graph" | "candidate_not_found" | "not_ready" | "near_twin" | "architect_unavailable",
    extra?: { workflowId?: string },
  ): SaveBranchResult => {
    logWarn(ctx, `branch draft refused graph=${graphId || "unknown"}: ${reason}`);
    return { ok: false, reason, ...extra };
  };

  if (!graphId) return refuse("unknown_graph");
  if (!candidateKey) return refuse("candidate_not_found");

  const loaded = await resolveLoadedWorkflow(deps, graphId, input.projectId);
  if (!loaded) return refuse("unknown_graph");

  const defaults = readBranchSettings(ctx.db);
  const windowDays = Math.max(1, Math.round(input.windowDays ?? deps.windowDays ?? defaults.windowDays));
  const repeats = Math.max(1, Math.round(input.repeats ?? deps.repeats ?? defaults.repeats));
  const since = (input.now ?? Date.now()) - windowDays * DAY_MS;

  const filter = { workflowId: graphId, since, onlyAccepted: true, limit: 2000 };
  const rawDeltas = deps.listInterventions
    ? deps.listInterventions(filter)
    : listTrajectoryDeltasForRunSafe(ctx.db, filter, { log: { warn: (msg) => logWarn(ctx, msg) } });

  const targetProjectId = loaded.workflow.scope.level === "project"
    ? (input.projectId?.trim() || loaded.workflow.scope.projectId || null)
    : null;
  const scopedDeltas = targetProjectId ? rawDeltas.filter((d) => d.projectId === targetProjectId) : rawDeltas;
  const matching = scopedDeltas.filter(
    (d) => branchCandidateKey({
      graphId,
      interventionKind: d.interventionKind,
      maskedSummary: d.maskedSummary,
      stageArchetype: d.stageArchetype,
    }) === candidateKey,
  );

  if (matching.length === 0) return refuse("candidate_not_found");
  if (matching.length < repeats) return refuse("not_ready");
  if (!deps?.architect?.createFrom) return refuse("architect_unavailable");

  const runsByThread = new Map<string, string[]>();
  const sourceRunIds: string[] = [];
  const seenRuns = new Set<string>();
  for (const row of matching) {
    const tid = row.threadId?.trim();
    if (!tid) continue;
    let threadRuns = runsByThread.get(tid);
    if (!threadRuns) {
      threadRuns = listRunIdsByWorkflowAndThreads(ctx.db as never, graphId, [tid]);
      runsByThread.set(tid, threadRuns);
    }
    for (const runId of threadRuns) {
      if (!seenRuns.has(runId)) {
        seenRuns.add(runId);
        sourceRunIds.push(runId);
      }
    }
  }

  const brief = buildBranchSaveBrief({
    graphId,
    candidateKey,
    deviations: matching.map((row) => ({
      kind: row.interventionKind,
      stageArchetype: row.stageArchetype,
      detail: row.maskedSummary,
      runIds: row.threadId?.trim() ? (runsByThread.get(row.threadId.trim()) ?? []) : [],
    })),
    sourceRunIds,
    note: input.note,
  });

  const scope = loaded.workflow.scope.level === "project" || loaded.workflow.scope.level === "section" ? "project" : "global";
  const projectId = input.projectId?.trim() || loaded.workflow.scope.projectId || matching.find((d) => d.projectId)?.projectId || "";
  const lockedBuiltin = (loaded.origin === "builtin" || Boolean(builtinWorkflow(graphId))) && !isEvolvableDomainBuiltinId(graphId);
  const workflowId = lockedBuiltin ? `${graphId.slice(0, 41)}-branch` : graphId;

  const created = await deps.architect.createFrom({
    projectId,
    scope,
    workflowId,
    definition: JSON.parse(JSON.stringify(loaded.workflow)) as Record<string, unknown>,
    name: loaded.workflow.name,
    description: loaded.workflow.description,
    ...(!lockedBuiltin && loaded.path && loaded.fileSha256
      ? { base: { path: loaded.path, sha256: loaded.fileSha256, version: loaded.workflow.version } }
      : {}),
    branchOf: graphId,
    exemptWorkflowId: graphId,
    dedupe: true,
    metadata: {
      source: "branch-capture",
      branchOf: graphId,
      candidateKey,
      sourceRunIds,
      brief,
      ...(input.note?.trim() ? { note: redactKnown(input.note.trim()) } : {}),
    },
  });

  if (!("id" in created)) {
    return refuse("near_twin", { workflowId: created.workflowId });
  }

  logInfo(ctx, `branch draft graph=${graphId} draft=${created.id} runs=${sourceRunIds.length}`);
  return { ok: true, draftId: created.id };
}
