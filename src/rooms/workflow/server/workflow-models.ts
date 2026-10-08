import type { z } from "zod";
import type { rpcContract } from "../../contracts";
import { casResetSettings, casUpsertSetting, getSettingVersions, listSettingRows } from "../../storage";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { DraftStore } from "../../storage";
import { validateChoice, type ModelCatalog } from "@lane-pilot/models";
import { CATALOG_WAIT_MS, createModelCatalog, modelCatalogOf, pmHostOf, within, type ModelCatalogReader } from "../../core/server";
import type { ServerCore } from "../../core/server";
import { stringAt } from "../../core/server";
import { MODEL_OVERRIDE_PREFIX, modelOverrideKey } from "./workflow-agent-model";
import { resolveStepExecutors, type PmPair, type WorkflowShape } from "./workflow-step-executors";

/** Who changed which override, when, from what to what; the last entries, in the plugin KV. */
export const OVERRIDE_JOURNAL_KEY = "workflow-model-override:journal";
const OVERRIDE_JOURNAL_KEEP = 500;

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
    /**
     * Writes or drops the owner's override of one step: a settings row of the project, or of all projects. A choice is checked
     * against the catalog of the machines first (provider, model, effort, tier, and the machine the project's helpers run on), and
     * every change or refusal is journaled with who, when, the old value and the new one (audit 2026-10-08 round 3, item 18).
     * `caller` is who asked, when the RPC layer knows; the journal says so when it does not.
     */
    async setOverride(input: Input<"workflow_model_override">, caller?: string | null): Promise<Output<"workflow_model_override">> {
      const projectId = input.scope === "global" ? GLOBAL_SETTINGS_PROJECT_ID : input.projectId;
      const key = modelOverrideKey(input.workflowId, input.nodeId);
      const before = listSettingRows(ctx.db, projectId).find((row) => row.key === key);
      const versions = getSettingVersions(ctx.db, projectId, [key]);
      const journal = async (result: string, value: unknown) => {
        const entry = { at: Date.now(), by: caller ?? null, scope: input.scope, projectId: input.projectId, workflowId: input.workflowId, nodeId: input.nodeId, old: before?.value ?? null, new: value, result };
        try {
          const known = await ctx.bb.storage.kv.get(OVERRIDE_JOURNAL_KEY).catch(() => null);
          await ctx.bb.storage.kv.set(OVERRIDE_JOURNAL_KEY, [...(Array.isArray(known) ? known : []), entry].slice(-OVERRIDE_JOURNAL_KEEP));
        } catch { /* the setting is what matters; the log line below is the fallback */ }
        ctx.bb.log.info(`Lane Pilot model override ${key} (${input.scope === "global" ? "all projects" : input.projectId}) by ${caller ?? "an unknown caller"}: ${result}`);
      };
      if (!input.choice) {
        if (!before) return { ok: true };
        const result = casResetSettings(ctx.db, { projectId, keys: [key], expectedVersions: versions, validationKeys: [key], validatedRows: listSettingRows(ctx.db, projectId) });
        await journal(result.ok ? "dropped" : "conflict", null);
        return result.ok ? { ok: true } : { ok: false, reason: "conflict" };
      }
      const { providerId, model, effort, serviceTier } = input.choice;
      // The machine is the one the project's helpers run on; without a catalog (no machine answered) nothing can be vouched for.
      const read = await within(catalog.get(), CATALOG_WAIT_MS).catch(() => null);
      if (!read?.providers.length) { await journal("catalog_unavailable", input.choice); return { ok: false, reason: "catalog_unavailable" }; }
      const verdict = validateChoice(await catalogFor(input.projectId, read), { providerId, model, effort: effort ?? null, serviceTier: serviceTier ?? null });
      if (!verdict.ok) { await journal(`refused:${verdict.code}`, input.choice); return { ok: false, reason: `${verdict.code}: ${verdict.detail}` }; }
      const value = { provider: providerId, model, ...(effort ? { reasoning_effort: effort } : {}), service_tier: serviceTier === "fast" ? "fast" : "default" };
      const result = casUpsertSetting(ctx.db, { projectId, key, value, expectedVersion: versions[key] ?? 0 });
      if (result.ok) { await journal("set", value); return { ok: true }; }
      const reason = result.conflict ? "conflict" : result.validation.params[1] ?? "invalid";
      await journal(`refused:${reason}`, value);
      return { ok: false, reason };
    },
    modelCatalog: async (input: { refresh?: boolean; projectId?: string }): Promise<Output<"workflow_model_catalog">> => {
      const read = await catalog.get(input.refresh === true);
      return input.projectId ? catalogFor(input.projectId, read) : read;
    },
  };
}

export { createModelCatalog, type ModelCatalogReader };
