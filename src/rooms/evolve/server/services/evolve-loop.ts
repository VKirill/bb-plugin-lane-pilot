import { EVOLVE_THRESHOLDS, LP_EVENTS } from "@lane-pilot/contracts";
import { ROLE_MODEL_OPTIONS, resolveRoleModel, type ModelCatalog } from "@lane-pilot/models";
import {
  DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
  GLOBAL_SETTINGS_PROJECT_ID,
  PATHS_BRANCH_DRAFT_REPEATS_KEY,
} from "@lane-pilot/settings-catalog";
import {
  fallbackRates,
  wfRunRow,
  type RawDefinition,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import type { LeadRoadApi, RoadRow } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { createModelCatalog } from "../../../platform/server";
import { listErrandEpisodeTraces } from "../../../storage";
import { parseEvolveSettings } from "../../settings";
import { addCase, caseCounts } from "../repositories/case-repository";
import {
  claimEvolveFlag,
  listHypotheses,
  markIngested,
  queueHypothesis,
} from "../repositories/ledger-repository";
import { makeLogSink, readMergedSettings } from "./context";
import { onCanaryRun, type DecideDeps } from "./decide";
import type { PlanGenerator, ScriptGenerator } from "./hypotheses";
import type { ReplayDeps } from "./replay";

const MISS_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export type EvolveEventKind = "run_finished" | "threshold" | "catalog_changed";

export type EvolveRunVerdictLike = {
  runId: string;
  workflowId: string;
  graphVersion: number;
  verdict: "accept" | "reject";
  source: string;
  reason: string | null;
  note: string | null;
  decidedAt: number;
};

export type EvolveRouteMissLike = {
  missId: string;
  projectId: string | null;
  briefExcerpt: string;
  category: string | null;
  createdAt: number;
};

export type EvolveProveResult = {
  ok: boolean;
  casesN: number;
  passedN: number;
  failures: Array<{ caseId: string; reason: string }>;
  reason?: string;
};

export type EvolveWorkflowDeps = {
  settings?: Record<string, unknown> | undefined;
  now?: (() => number) | undefined;
  emitEvent?: ((
    name: string,
    payload?: Record<string, unknown>,
    options?: { id?: string; key?: string; projectId?: string },
  ) => Promise<unknown>) | undefined;
  workflowTriggers?: {
    emitEvent?: (
      name: string,
      payload?: Record<string, unknown>,
      options?: { id?: string; key?: string; projectId?: string },
    ) => Promise<unknown>;
  } | undefined;
  workflowLibrary?: {
    loadStore: (projectId?: string) => Promise<{
      store: {
        get(id: string): { workflow: Workflow } | null;
        resolve(id: string, version?: number): Workflow | null;
        list(): Array<{ workflow: Workflow }>;
      };
    }>;
  } | undefined;
  workflowEngine?: { resolveWorkflow?: (id: string, version?: number) => Workflow | null } | undefined;
  loadWorkflow?: ((workflowId: string) => Workflow | RawDefinition | null | Promise<Workflow | RawDefinition | null>) | undefined;
  loadBuiltinWorkflow?: ((workflowId: string) => Workflow | null) | undefined;
  resolveWorkflow?: ((id: string, version?: number) => Workflow | null) | undefined;
  leadRoad?: Pick<LeadRoadApi, "addRoad" | "doneRoad" | "getRoad" | "listRoad"> | undefined;
  listRouteMisses?: ((filter: { since: number; projectId?: string | null; limit?: number }) => readonly EvolveRouteMissLike[]) | undefined;
  checkNearTwin?: ((input: { scope: "global" | "project"; projectId: string; trace: string[] }) => Promise<boolean>) | undefined;
  catalog?: ModelCatalog | null | undefined;
  readCatalog?: (() => Promise<ModelCatalog | null>) | undefined;
  generatePlan?: PlanGenerator | undefined;
  generateScript?: ScriptGenerator | undefined;
  computeFingerprint?: (() => string | null | undefined) | undefined;
  getRunVerdict?: ((runId: string) => EvolveRunVerdictLike | null) | undefined;
  listRunVerdicts?: ((filter: { workflowId?: string; since?: number; limit?: number }) => readonly EvolveRunVerdictLike[]) | undefined;
  evolvePublishDraft?: DecideDeps["publishDraft"] | undefined;
  evolveRollbackDraft?: DecideDeps["rollbackDraft"] | undefined;
  replayDeps?: Partial<ReplayDeps> | undefined;
  decideDeps?: Partial<DecideDeps> | undefined;
  proveWorkflow?: ((input: {
    workflowId: string;
    provider: string;
    model: string;
    projectId?: string;
    catalog?: ModelCatalog;
  }) => Promise<EvolveProveResult>) | undefined;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveEventKind(inputs: Record<string, unknown>): EvolveEventKind {
  const explicit = str(inputs.eventKind);
  if (explicit === "run_finished" || explicit === "threshold" || explicit === "catalog_changed") {
    return explicit;
  }
  if (typeof inputs.prevSha === "string" || typeof inputs.nextSha === "string") {
    return "catalog_changed";
  }
  if (typeof inputs.thresholdReason === "string" || (typeof inputs.reason === "string" && !str(inputs.runId))) {
    return "threshold";
  }
  return "run_finished";
}

function readRepeatsThreshold(settings: Record<string, unknown>): number {
  const raw = settings[PATHS_BRANCH_DRAFT_REPEATS_KEY];
  const parsed = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : DEFAULT_PATHS_BRANCH_DRAFT_REPEATS;
}

function readCategoryTrace(ctx: Pick<ServerCore, "db">, runId: string | undefined): string[] {
  if (!runId) return [];
  try {
    const raw = listErrandEpisodeTraces(ctx.db, [runId]).get(runId);
    if (!raw || !raw.trim()) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const trace: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && item.trim()) trace.push(item.trim());
      else if (isRecord(item) && typeof item.tool === "string" && item.tool.trim()) trace.push(item.tool.trim());
    }
    return trace;
  } catch {
    return [];
  }
}

async function syncCatalogMissRoadProposals(
  ctx: Pick<ServerCore, "db" | "bb" | "log">,
  deps: EvolveWorkflowDeps,
  input: { now: number; settings: Record<string, unknown>; runId?: string; projectId?: string | null },
): Promise<number> {
  if (!deps.listRouteMisses || !deps.leadRoad) return 0;
  const since = input.now - MISS_WINDOW_DAYS * DAY_MS;
  const misses = deps.listRouteMisses({ since, limit: 2000 });
  if (misses.length === 0) return 0;

  const byCategory = new Map<string, EvolveRouteMissLike[]>();
  for (const miss of misses) {
    if (!miss.category) continue;
    const list = byCategory.get(miss.category) ?? [];
    list.push(miss);
    byCategory.set(miss.category, list);
  }
  if (byCategory.size === 0) return 0;

  const repeats = readRepeatsThreshold(input.settings);
  const { leadRoad } = deps;
  const ensureRoot = (): RoadRow =>
    leadRoad.getRoad(ctx.db as never, "dir:hub")
    ?? leadRoad.addRoad(ctx.db as never, {
      id: "dir:hub",
      projectId: null,
      title: "Above projects",
      kind: "direction",
      source: "lead",
      why: "the root the lead files a project's branches under when a proposal names no parent",
    }, input.now);

  let created = 0;
  for (const [category, group] of byCategory) {
    if (group.length < repeats) continue;
    const payloadKey = `miss-category:${category}`;
    const existing = leadRoad.listRoad(ctx.db as never, { limit: 500 }).find((row) => {
      if (row.class !== "process") return false;
      const payload = parseJsonObject(row.payload_json);
      return payload?.category === category || payload?.key === payloadKey;
    });
    if (existing) continue;

    const projectIds = [...new Set(group.map((m) => m.projectId).filter((id): id is string => Boolean(id)))];
    const targetProjectId = projectIds.length === 1 ? projectIds[0]! : null;
    const trace = readCategoryTrace(ctx, input.runId);
    if (trace.length > 0 && deps.checkNearTwin) {
      const isNearTwin = await deps.checkNearTwin({
        scope: "global",
        projectId: targetProjectId ?? input.projectId ?? GLOBAL_SETTINGS_PROJECT_ID,
        trace,
      });
      if (isNearTwin) continue;
    }

    const parent = ensureRoot();
    leadRoad.addRoad(ctx.db as never, {
      parentId: parent.id,
      projectId: targetProjectId,
      title: `Граф для категории: ${category}`,
      kind: "option",
      source: "lead",
      class: "process",
      why: `Repeated catalog misses in category "${category}" (${group.length} in 30d).`,
      evidence: group.slice(0, 12).map((m) => ({ kind: "note" as const, ref: m.missId, label: m.briefExcerpt })),
      payload: { key: payloadKey, category, missIds: group.map((m) => m.missId) },
    }, input.now);
    created += 1;
  }
  return created;
}

function pickFallbackModelVariant(
  node: { role: string; provider?: string; model?: string } | undefined,
  currentProvider: string,
  currentModel: string,
  settings: Record<string, unknown>,
): { provider: string; model: string } | null {
  const role = node?.role ?? "errand";
  const resolved = resolveRoleModel(role, settings);
  if (resolved.model && (resolved.providerId !== currentProvider || resolved.model !== currentModel)) {
    return { provider: resolved.providerId, model: resolved.model };
  }
  const roleDefault = resolveRoleModel(role, {});
  if (roleDefault.model && (roleDefault.providerId !== currentProvider || roleDefault.model !== currentModel)) {
    return { provider: roleDefault.providerId, model: roleDefault.model };
  }
  const alt = ROLE_MODEL_OPTIONS.find((opt) => opt.providerId !== currentProvider || opt.id !== currentModel);
  return alt ? { provider: alt.providerId, model: alt.id } : null;
}

export async function loadWorkflowForEvolve(
  ctx: Pick<ServerCore, "db">,
  deps: EvolveWorkflowDeps,
  workflowId: string,
  projectId?: string | null,
): Promise<Workflow | RawDefinition | null> {
  if (deps.loadWorkflow) {
    const custom = await deps.loadWorkflow(workflowId);
    if (custom) return custom;
  }
  if (deps.workflowLibrary) {
    const { store } = await deps.workflowLibrary.loadStore(projectId ?? undefined);
    const found = store.get(workflowId)?.workflow;
    if (found) return found;
  }
  return deps.resolveWorkflow?.(workflowId)
    ?? deps.workflowEngine?.resolveWorkflow?.(workflowId)
    ?? deps.loadBuiltinWorkflow?.(workflowId)
    ?? null;
}

export async function runEvolveIngest(
  ctx: Pick<ServerCore, "db" | "bb" | "log"> & Partial<Pick<ServerCore, "manualMode">>,
  deps: EvolveWorkflowDeps,
  inputs: Record<string, unknown>,
  nowMs: number,
) {
  const log = makeLogSink({ bb: ctx.bb, log: ctx.log });
  const projectId = str(inputs.projectId) || null;
  const settings = readMergedSettings({ db: ctx.db, projectId: projectId ?? GLOBAL_SETTINGS_PROJECT_ID, settings: deps.settings });
  const evolveCfg = parseEvolveSettings(settings);
  if (!evolveCfg.enabled) {
    return { skipped: "disabled", kind: "skip", route: "done", workflowId: "", runId: "", ingested: false };
  }

  const kind = resolveEventKind(inputs);
  const workflowId = str(inputs.workflowId);
  const runId = str(inputs.runId);
  log.info(`evolve event kind=${kind} wf=${workflowId || "*"}`);

  if (kind === "catalog_changed") {
    return { kind, route: "reprove", workflowId: "", runId: "", ingested: false };
  }
  if (kind === "threshold") {
    const route = workflowId && evolveCfg.graphs.includes(workflowId) ? "propose" : "done";
    return { kind, route, workflowId, runId: "", ingested: false };
  }
  if (!workflowId || !runId) {
    return { kind, route: "done", workflowId, runId, ingested: false };
  }

  if (workflowId === "errand") {
    const isNew = markIngested(ctx.db, runId, workflowId, nowMs, log);
    if (!isNew) return { kind, route: "done", workflowId, runId, ingested: false };
    await syncCatalogMissRoadProposals(ctx, deps, { now: nowMs, settings, runId, projectId });
    const route = evolveCfg.graphs.includes("errand") ? "propose" : "done";
    return { kind, route, workflowId, runId, ingested: true };
  }

  if (!evolveCfg.graphs.includes(workflowId)) {
    return { kind, route: "done", workflowId, runId, ingested: false };
  }

  const isNew = markIngested(ctx.db, runId, workflowId, nowMs, log);
  if (!isNew) {
    return { kind, route: "done", workflowId, runId, ingested: false };
  }

  const emitEvent = deps.emitEvent ?? deps.workflowTriggers?.emitEvent;
  const runRow = wfRunRow(ctx.db, runId);
  const verdict = deps.getRunVerdict?.(runId) ?? null;
  if (verdict) {
    const rawVersion = typeof inputs.graphVersion === "number" ? inputs.graphVersion : Number(inputs.graphVersion);
    const graphVersion = verdict.graphVersion || runRow?.workflow_version || (Number.isFinite(rawVersion) && rawVersion > 0 ? rawVersion : 1);
    addCase(ctx.db, { workflowId, runId, verdict: verdict.verdict, graphVersion, now: nowMs }, log);
  }

  const counts = caseCounts(ctx.db, workflowId);
  if (counts.heldOut >= EVOLVE_THRESHOLDS.heldOutMin && counts.working >= EVOLVE_THRESHOLDS.workingMin) {
    if (claimEvolveFlag(ctx.db, `threshold:cases:${workflowId}`, String(nowMs))) {
      await emitEvent?.(
        LP_EVENTS.EVOLVE_THRESHOLD_CROSSED,
        { workflowId, reason: "cases_threshold", heldOut: counts.heldOut, working: counts.working },
        { id: `evolve-threshold:cases:${workflowId}`, key: workflowId, ...(projectId ? { projectId } : {}) },
      );
    }
  }

  for (const rateEntry of fallbackRates(ctx.db, { workflowId })) {
    if (rateEntry.rate === null || rateEntry.rate <= EVOLVE_THRESHOLDS.fallbackDemote) continue;
    const flagKey = `threshold:fallback:${workflowId}:${rateEntry.nodeId}:${rateEntry.graphVersion}:${rateEntry.form}`;
    if (claimEvolveFlag(ctx.db, flagKey, String(nowMs))) {
      await emitEvent?.(
        LP_EVENTS.EVOLVE_THRESHOLD_CROSSED,
        {
          workflowId,
          reason: "fallback_over_20pct",
          nodeId: rateEntry.nodeId,
          graphVersion: rateEntry.graphVersion,
          form: rateEntry.form,
          rate: rateEntry.rate,
        },
        { id: `evolve-threshold:fallback:${workflowId}:${rateEntry.nodeId}:${rateEntry.graphVersion}:${rateEntry.form}`, key: workflowId, ...(projectId ? { projectId } : {}) },
      );
    }
  }

  if (runRow?.trial_id) {
    await onCanaryRun(
      { db: ctx.db, bb: ctx.bb, projectId: runRow.project_id ?? projectId, settings, log, manualMode: ctx.manualMode },
      {
        publishDraft: deps.evolvePublishDraft,
        rollbackDraft: deps.evolveRollbackDraft,
        getRunVerdict: deps.getRunVerdict,
        now: () => nowMs,
        ...deps.decideDeps,
      },
      runRow,
    );
  }

  return { kind, route: "propose", workflowId, runId, ingested: true };
}

export async function runEvolveReprove(
  ctx: Pick<ServerCore, "db" | "bb" | "log">,
  deps: EvolveWorkflowDeps,
  projectId: string | null,
  nowMs: number,
) {
  const log = makeLogSink({ bb: ctx.bb, log: ctx.log });
  const settings = readMergedSettings({ db: ctx.db, projectId: projectId ?? GLOBAL_SETTINGS_PROJECT_ID, settings: deps.settings });
  const evolveCfg = parseEvolveSettings(settings);
  if (!evolveCfg.enabled) {
    return { skipped: "disabled", checked: 0, demotionsQueued: 0, hypothesisIds: [] };
  }

  if (!deps.proveWorkflow) {
    return { checked: 0, demotionsQueued: 0, hypothesisIds: [] };
  }

  const promoted = listHypotheses(ctx.db, { state: "promoted" });
  const queuedIds: string[] = [];
  let checked = 0;

  for (const hyp of promoted) {
    if (hyp.source === "fallback") continue;
    const variant = parseJsonObject(hyp.variantJson);
    const isModelVariant = hyp.armKind === "model";
    const isPlanVariant = hyp.armKind === "form" && variant?.form === "plan";
    if (!isModelVariant && !isPlanVariant) continue;

    const wf = await loadWorkflowForEvolve(ctx, deps, hyp.workflowId, projectId);
    if (!wf || !("nodes" in wf) || !Array.isArray(wf.nodes)) continue;
    const typedWf = wf as Workflow;
    const node = typedWf.nodes.find((n) => n.id === hyp.nodeId);
    const agentNode = node?.type === "agent" ? node : undefined;

    const resolvedRole = resolveRoleModel(agentNode?.role ?? "errand", settings);
    const provider = str(variant?.provider) || agentNode?.provider || resolvedRole.providerId;
    const model = str(variant?.model) || agentNode?.model || resolvedRole.model;
    if (!provider || !model) continue;

    checked += 1;
    const proveResult = await deps.proveWorkflow({
      workflowId: hyp.workflowId,
      provider,
      model,
      ...(projectId ? { projectId } : {}),
      ...(deps.catalog !== undefined && deps.catalog !== null ? { catalog: deps.catalog } : {}),
    });

    if (proveResult.ok || proveResult.reason === "no_cases") continue;

    const demoteArmKind = isPlanVariant ? "form" : "model";
    const builtinNode = deps.loadBuiltinWorkflow?.(hyp.workflowId)?.nodes.find((n) => n.id === hyp.nodeId);
    const baselineNode = builtinNode?.type === "agent" ? builtinNode : agentNode;
    const demoteVariant = isPlanVariant
      ? { form: "agent", ...(agentNode?.fallback !== undefined ? { fallback: null } : {}) }
      : pickFallbackModelVariant(baselineNode, provider, model, settings);
    if (!demoteVariant) continue;

    const queued = queueHypothesis(
      ctx.db,
      {
        workflowId: hyp.workflowId,
        nodeId: hyp.nodeId,
        armKind: demoteArmKind,
        variant: demoteVariant,
        graphVersion: typedWf.version,
        source: "catalog_change",
        reason: proveResult.reason ?? `proof_failed:${proveResult.passedN}/${proveResult.casesN}`,
        now: nowMs,
        bypassCap: true,
      },
      log,
    );
    if (queued.ok) queuedIds.push(queued.hypothesis.id);
  }

  return { checked, demotionsQueued: queuedIds.length, hypothesisIds: queuedIds };
}

export { createModelCatalog };
