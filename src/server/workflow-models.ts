import type { z } from "zod";
import type { rpcContract } from "../contracts";
import { GLOBAL_SETTINGS_PROJECT_ID } from "../lp-defaults";
import { mapListedQaHosts } from "../qa-host";
import type { DraftStore } from "../workflow/draft-store";
import type { CatalogProvider, ModelCatalog } from "../workflow/model-catalog";
import type { ServerCore } from "./core";
import { stringAt } from "./values";
import { resolveStepExecutors, type PmPair } from "./workflow-step-executors";

type Output<K extends keyof typeof rpcContract> = z.infer<(typeof rpcContract)[K]["output"]>;

const CATALOG_TTL_MS = 60_000;
const CALL_TIMEOUT_MS = 8_000;
const CATALOG_WAIT_MS = 6_000;

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); })]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Every provider and model the hub's machines offer, read through `bb.sdk.providers` on each connected machine and merged: a
 * provider or model lists the machines it is available on, so a picker can say «only on the Mac mini». Kept for a minute; a machine
 * that does not answer is left out instead of blocking the others.
 */
export function createModelCatalog(ctx: Pick<ServerCore, "bb" | "log">, now: () => number = Date.now) {
  const { bb } = ctx;
  let cached: { at: number; value: ModelCatalog } | null = null;
  let inflight: Promise<ModelCatalog> | null = null;

  async function read(): Promise<ModelCatalog> {
    const hosts = mapListedQaHosts(await (bb.sdk as unknown as { hosts: { list: () => Promise<unknown> } }).hosts.list().catch(() => []));
    const providers = new Map<string, CatalogProvider>();
    await Promise.all(hosts.filter((host) => host.connected).map(async (host) => {
      const listed = await within(Promise.resolve(bb.sdk.providers.list({ hostId: host.id })), CALL_TIMEOUT_MS).catch(() => []);
      await Promise.all(listed.map(async (info) => {
        const entry = providers.get(info.id) ?? {
          id: info.id, displayName: info.displayName || info.id, logoUrl: info.logoUrl ?? null, family: info.family ?? null,
          supportsServiceTier: Boolean(info.capabilities?.supportsServiceTier), serviceTiers: (info.serviceTiers ?? []).map((tier) => tier.id), hostIds: [], models: [],
        };
        providers.set(info.id, entry);
        if (!info.available) return;
        entry.hostIds.push(host.id);
        const models = await within(Promise.resolve(bb.sdk.providers.models({ providerId: info.id, hostId: host.id })), CALL_TIMEOUT_MS).then((row) => row.models, () => []);
        for (const row of models) {
          const known = entry.models.find((item) => item.id === row.id);
          if (known) { known.hostIds.push(host.id); continue; }
          entry.models.push({
            id: row.id, model: row.model, displayName: row.displayName || row.model || row.id,
            efforts: row.supportedReasoningEfforts.map((item) => item.reasoningEffort), defaultEffort: row.defaultReasoningEffort ?? null, isDefault: Boolean(row.isDefault), hostIds: [host.id],
          });
        }
      }));
    }));
    // A model some machine has comes first; a provider like OpenCode lists hundreds, and the picker is typed into by its first letters.
    for (const entry of providers.values()) entry.models.sort((a, b) => Number(b.hostIds.length > 0) - Number(a.hostIds.length > 0) || a.displayName.localeCompare(b.displayName));
    return {
      hosts: hosts.map((host) => ({ id: host.id, name: host.name, connected: host.connected })),
      providers: [...providers.values()].sort((a, b) => Number(b.hostIds.length > 0) - Number(a.hostIds.length > 0) || a.displayName.localeCompare(b.displayName)),
    };
  }

  async function get(refresh = false): Promise<ModelCatalog> {
    if (!refresh && cached && now() - cached.at < CATALOG_TTL_MS) return cached.value;
    inflight ??= read().then((value) => { cached = { at: now(), value }; return value; }).finally(() => { inflight = null; });
    return inflight;
  }

  return { get };
}
export type ModelCatalogReader = ReturnType<typeof createModelCatalog>;

/** The model the project's PM chat runs on: the last model of a writer chain. Unknown when no PM chat of the project is open. */
async function pmPairOf(ctx: ServerCore, projectId: string): Promise<PmPair | null> {
  const row = ctx.db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE kind='cli' AND project_id=? AND closed_at IS NULL AND pm_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(projectId) as { pm_thread_id: string } | undefined;
  if (!row) return null;
  const options = await ctx.bb.sdk.threads.defaultExecutionOptions({ threadId: row.pm_thread_id }).catch(() => null);
  const providerId = stringAt(options, "providerId"), model = stringAt(options, "model");
  return providerId && model ? { providerId, model } : null;
}

/** `workflow_step_executors` and `workflow_model_catalog`. */
export function createWorkflowModels(ctx: ServerCore, deps: { drafts: Pick<DraftStore, "get">; source: (input: { id: string; projectId?: string }) => Promise<{ workflow: { nodes: ReadonlyArray<unknown> } } | null>; catalog?: ModelCatalogReader }) {
  const catalog = deps.catalog ?? createModelCatalog(ctx);
  return {
    catalog,
    async stepExecutors(input: { workflowId?: string; draftId?: string; projectId?: string }): Promise<Output<"workflow_step_executors">> {
      let nodes: ReadonlyArray<unknown> | null = null;
      let projectId = input.projectId;
      if (input.draftId) {
        const draft = deps.drafts.get(input.draftId);
        if (draft) { nodes = Array.isArray(draft.definition.nodes) ? draft.definition.nodes : []; projectId ??= draft.projectId; }
      } else if (input.workflowId) {
        const found = await deps.source({ id: input.workflowId, ...(projectId ? { projectId } : {}) });
        if (found) nodes = found.workflow.nodes;
      }
      if (!nodes) return { found: false, executors: [], pm: null };
      const scope = projectId ?? GLOBAL_SETTINGS_PROJECT_ID;
      const [settings, pm, offered] = await Promise.all([
        ctx.effectiveProjectSettings(scope).then((row) => row.values),
        projectId ? pmPairOf(ctx, projectId).catch(() => null) : Promise.resolve(null),
        within(catalog.get(), CATALOG_WAIT_MS).catch(() => null),
      ]);
      // A catalog that lists nothing (no machine answered) is no evidence that a model is missing.
      return { found: true, executors: resolveStepExecutors({ nodes, settings, pm, catalog: offered?.providers.length ? offered : null }), pm };
    },
    modelCatalog: (input: { refresh?: boolean }): Promise<Output<"workflow_model_catalog">> => catalog.get(input.refresh === true),
  };
}
