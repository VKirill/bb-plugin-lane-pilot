import type { z } from "zod";
import type { rpcContract } from "../contracts";
import { casResetSettings, casUpsertSetting, getSettingVersions, listSettingRows } from "../database";
import { GLOBAL_SETTINGS_PROJECT_ID } from "../lp-defaults";
import type { DraftStore } from "../workflow/draft-store";
import type { ModelCatalog } from "../workflow/model-catalog";
import { CATALOG_WAIT_MS, createModelCatalog, modelCatalogOf, pmHostOf, within, type ModelCatalogReader } from "./model-catalog-reader";
import type { ServerCore } from "./core";
import { stringAt } from "./values";
import { MODEL_OVERRIDE_PREFIX, modelOverrideKey } from "./workflow-agent-model";
import { resolveStepExecutors, type PmPair, type WorkflowShape } from "./workflow-step-executors";

type Output<K extends keyof typeof rpcContract> = z.infer<(typeof rpcContract)[K]["output"]>;
type Input<K extends keyof typeof rpcContract> = z.infer<(typeof rpcContract)[K]["input"]>;


/** The model the project's PM chat runs on: the last model of a writer chain. Unknown when no PM chat of the project is open. */
const pmThreadOfProject = (ctx: ServerCore, projectId: string): string | null =>
  (ctx.db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE kind='cli' AND project_id=? AND closed_at IS NULL AND pm_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(projectId) as { pm_thread_id: string } | undefined)?.pm_thread_id ?? null;

async function pmPairOf(ctx: ServerCore, projectId: string): Promise<PmPair | null> {
  const thread = pmThreadOfProject(ctx, projectId);
  if (!thread) return null;
  const options = await ctx.bb.sdk.threads.defaultExecutionOptions({ threadId: thread }).catch(() => null);
  const providerId = stringAt(options, "providerId"), model = stringAt(options, "model");
  return providerId && model ? { providerId, model } : null;
}

/** `workflow_step_executors` and `workflow_model_catalog`. */
export function createWorkflowModels(ctx: ServerCore, deps: { drafts: Pick<DraftStore, "get">; source: (input: { id: string; projectId?: string }) => Promise<{ workflow: WorkflowShape } | null>; catalog?: ModelCatalogReader }) {
  const catalog = deps.catalog ?? modelCatalogOf(ctx);
  /** The catalog with the machine the project's helpers run on (the PM chat's environment), so a model is judged against that machine. */
  const catalogFor = async (projectId: string | undefined, read: ModelCatalog): Promise<ModelCatalog> => {
    const thread = projectId ? (() => { try { return pmThreadOfProject(ctx, projectId); } catch { return null; } })() : null;
    const runHostId = thread ? await pmHostOf(ctx.bb, thread).catch(() => null) : null;
    return { ...read, runHostId };
  };
  return {
    catalog,
    async stepExecutors(input: { workflowId?: string; draftId?: string; projectId?: string }): Promise<Output<"workflow_step_executors">> {
      let shape: WorkflowShape | null = null;
      let projectId = input.projectId;
      let workflowId = input.workflowId;
      if (input.draftId) {
        const draft = deps.drafts.get(input.draftId);
        if (draft) {
          const { nodes, edges, entry } = draft.definition as { nodes?: unknown; edges?: unknown; entry?: unknown };
          shape = { nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [], entry: typeof entry === "string" ? entry : undefined };
          projectId ??= draft.projectId; workflowId = draft.workflowId;
        }
      } else if (input.workflowId) {
        const found = await deps.source({ id: input.workflowId, ...(projectId ? { projectId } : {}) });
        if (found) shape = found.workflow;
      }
      if (!shape) return { found: false, executors: [], pm: null };
      // The workflows its subworkflow nodes call, followed to the depth the view lists: their steps run on models too.
      const fragments = new Map<string, WorkflowShape>();
      const collect = async (from: WorkflowShape, depth: number): Promise<void> => {
        for (const node of from.nodes) {
          const callee = typeof node === "object" && node !== null && (node as { type?: unknown }).type === "subworkflow" ? (node as { workflow?: unknown }).workflow : null;
          if (typeof callee !== "string" || !callee || fragments.has(callee) || depth > 3) continue;
          const found = await deps.source({ id: callee, ...(projectId ? { projectId } : {}) }).catch(() => null);
          if (!found) continue;
          fragments.set(callee, found.workflow);
          await collect(found.workflow, depth + 1);
        }
      };
      await collect(shape, 0);
      const scope = projectId ?? GLOBAL_SETTINGS_PROJECT_ID;
      const [settings, pm, read] = await Promise.all([
        ctx.effectiveProjectSettings(scope).then((row) => row.values),
        projectId ? pmPairOf(ctx, projectId).catch(() => null) : Promise.resolve(null),
        within(catalog.get(), CATALOG_WAIT_MS).catch(() => null),
      ]);
      const offered = read ? await catalogFor(projectId, read) : null;
      // The keys the project holds itself tell an override of the project from one for all projects.
      const ownKeys = new Set(projectId && Object.keys(settings).some((key) => key.startsWith(MODEL_OVERRIDE_PREFIX)) ? listSettingRows(ctx.db, projectId).map((row) => row.key) : []);
      // A catalog that lists nothing (no machine answered) is no evidence that a model is missing.
      return { found: true, executors: resolveStepExecutors({ nodes: shape.nodes, edges: shape.edges, entry: shape.entry, fragments, settings, pm, catalog: offered?.providers.length ? offered : null, workflowId, ownKeys }), pm };
    },
    /** Writes or drops the owner's override of one step: a settings row of the project, or of all projects. */
    async setOverride(input: Input<"workflow_model_override">): Promise<Output<"workflow_model_override">> {
      const projectId = input.scope === "global" ? GLOBAL_SETTINGS_PROJECT_ID : input.projectId;
      const key = modelOverrideKey(input.workflowId, input.nodeId);
      const known = listSettingRows(ctx.db, projectId).some((row) => row.key === key);
      const versions = getSettingVersions(ctx.db, projectId, [key]);
      if (!input.choice) {
        if (!known) return { ok: true };
        const result = casResetSettings(ctx.db, { projectId, keys: [key], expectedVersions: versions, validationKeys: [key], validatedRows: listSettingRows(ctx.db, projectId) });
        return result.ok ? { ok: true } : { ok: false, reason: "conflict" };
      }
      const { providerId, model, effort, serviceTier } = input.choice;
      const value = { provider: providerId, model, ...(effort ? { reasoning_effort: effort } : {}), service_tier: serviceTier === "fast" ? "fast" : "default" };
      const result = casUpsertSetting(ctx.db, { projectId, key, value, expectedVersion: versions[key] ?? 0 });
      if (result.ok) return { ok: true };
      return { ok: false, reason: result.conflict ? "conflict" : result.validation.params[1] ?? "invalid" };
    },
    modelCatalog: async (input: { refresh?: boolean; projectId?: string }): Promise<Output<"workflow_model_catalog">> => {
      const read = await catalog.get(input.refresh === true);
      return input.projectId ? catalogFor(input.projectId, read) : read;
    },
  };
}

export { createModelCatalog, type ModelCatalogReader };
