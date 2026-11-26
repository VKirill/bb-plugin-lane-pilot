import { bestEffort, stringAt } from "@lane-pilot/kit";
import { findModelIn, roleRowOf } from "@lane-pilot/models";
import type { ChainRuntime, ServerCore } from "../../../contracts/server";
import { PROVIDER_FOLDER_BLOCK_TTL_MS, modelCatalogOf, pmHostOf, projectFolder, providerBlockedForFolder, readProviderFolderBlock, resolveSpawnModel, spawnUsageOf, warmSpawnUsage } from "../../../platform/server";
import { getRunSettingsScopes } from "../../../storage";
import { assembleHelperModelResolution, type HelperModelResolution } from "../../models/helper-model-provenance";
import { AUTHOR_ROWS, AUTHOR_ROW_IDS, pmAuthorOf } from "../../models/workflow-agent-model";
import { HelperFailure, type HelperRequest } from "./workflow-agent-spec";
import { pickPlanSmallModel } from "./workflow-plan-form";
import { switchedFromProvider } from "./workflow-role-fallback";

/** Reads effective project settings for a helper step's runtime context. */
export const settingsOf = async (rt: ChainRuntime): Promise<Record<string, unknown>> =>
  (await bestEffort(rt.ctx.log, "workflow helper settings", Promise.resolve().then(() => rt.ctx.effectiveProjectSettings(rt.projectId, rt.runId ? getRunSettingsScopes(rt.ctx.db, rt.runId) : [])), null))?.values ?? {};

/** The model the PM chat runs on; null when BB cannot say. */
export async function pmPairOfThread(bb: ServerCore["bb"], threadId: string): Promise<{ providerId: string; model: string } | null> {
  try {
    const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
    const providerId = stringAt(options, "providerId"), model = stringAt(options, "model");
    return providerId && model ? { providerId, model } : null;
  } catch { return null; }
}

type Pair = { providerId: string; model: string };
/** Where the model an author row ran on is kept: per Lane Pilot run (the phase's planner is read by its plan critic and its auditor), else per workflow run. */
const authorKey = (rt: ChainRuntime, workflowRunId: string, row: string) => `author-model:${rt.runId ?? workflowRunId}:${row}`;

/**
 * The model that wrote the work a judge row judges: the planner (else the analyst) of the same run, as recorded when their step was resolved.
 * A plan critic with no planner on record is judging the plan of the PM chat, so the PM's model stands in. Unknown (nothing recorded, the
 * KV unreadable, a role that judges no one): null, and the table's choice stands.
 */
async function authorOf(rt: ChainRuntime, workflowRunId: string, row: string, pm: Pair | null): Promise<Pair | null> {
  const rows = AUTHOR_ROWS[row];
  if (!rows) return null;
  for (const author of rows) {
    const kept = await bestEffort(rt.ctx.bb.log, "workflow author pair read", rt.ctx.bb.storage?.kv.get<Pair>(authorKey(rt, workflowRunId, author)), null);
    if (kept?.providerId && kept.model) return { providerId: kept.providerId, model: kept.model };
  }
  return pmAuthorOf(row, pm);
}

/** Keeps the model an author row runs on for the judges of the same run (the same value each time the step is resolved again after a reload). */
async function rememberAuthor(rt: ChainRuntime, workflowRunId: string, row: string, chosen: Pair): Promise<void> {
  await bestEffort(rt.ctx.bb.log, "workflow author pair write", rt.ctx.bb.storage?.kv.set(authorKey(rt, workflowRunId, row), { providerId: chosen.providerId, model: chosen.model }), undefined);
}

/**
 * The request with the model the step will run on written into it: the role's row of the table (the one resolver, `resolveSpawnModel`, decides;
 * the Models view calls the same function), unless a scheduled agent or an owner-created agent pins its own. Every helper step comes
 * through here, from the generic agent node to the goal audit and the contract planner (`run` resolves what was not resolved before).
 * `avoidProvider`: a provider that just hit its limit is taken out of the offer and no pin applies, so the answer is the role's next model.
 */
export async function withResolvedModel(request: HelperRequest, options: { avoidProvider?: string | null; reason?: HelperModelResolution["reason"] } = {}): Promise<HelperRequest> {
  const { rt } = request;
  const settings = await settingsOf(rt);
  const avoid = options.avoidProvider ?? (request.nodeModel ? null : await bestEffort(rt.ctx.log, "workflow role switch read", switchedFromProvider(rt.ctx.bb.storage?.kv, settings, request.role), null));
  const pm = rt.pmThreadId ? await pmPairOfThread(rt.ctx.bb, rt.pmThreadId) : null;
  // The helper starts in the PM chat's environment, on one machine: a model that machine does not offer is passed over (the table's row)
  // or, when the run pins it itself, refused here with the machines that do have it, instead of failing inside the spawn.
  const hostId = rt.pmThreadId ? await bestEffort(rt.ctx.log, "workflow helper PM host", pmHostOf(rt.ctx.bb, rt.pmThreadId), null) : (await bestEffort(rt.ctx.log, "workflow helper project folder", projectFolder(rt.ctx.bb, rt.projectId), null))?.hostId ?? null;
  // The folder the thread starts in: a provider that cannot work there (opencode2 under ~/Documents on macOS: its
  // /api/mcp 500s EPERM) is out of the offer like a failed one (`providerBlockedForFolder` in spawn-model).
  const pmEnvPath = rt.pmThreadId
    ? await bestEffort(rt.ctx.log, "workflow helper PM environment", Promise.resolve().then(async () => {
        const pm = await rt.ctx.bb.sdk.threads.get({ threadId: rt.pmThreadId! });
        const environmentId = stringAt(pm, "environmentId");
        return environmentId ? stringAt(await rt.ctx.bb.sdk.environments.get({ environmentId }), "path") : null;
      }), null)
    : null;
  // Reading the PM thread's folder must never break the pick: when it is unavailable the project folder answers,
  // as in a run without a PM chat.
  const envPath = pmEnvPath ?? (await bestEffort(rt.ctx.log, "workflow helper project folder", projectFolder(rt.ctx.bb, rt.projectId), null))?.path ?? null;
  const read = (() => { try { return modelCatalogOf(rt.ctx).peek(); } catch { return null; } })();
  // An agent the owner created may name its own model and effort: they pin the run unless the schedule named one.
  const specialist = request.role.startsWith("specialist:") ? request.role.slice("specialist:".length) : "";
  const ownedEntry = !avoid && specialist ? (await bestEffort(rt.ctx.log, "workflow helper owned agents", Promise.resolve().then(() => rt.ctx.ownedAgents()), {} as Awaited<ReturnType<typeof rt.ctx.ownedAgents>>))[specialist] : undefined;
  const agentMeta = ownedEntry && !ownedEntry.compiledCorrupt ? ownedEntry.meta : undefined;
  // The only models a run may pin: the one a scheduled agent names, and the one an owner-created agent names. The graph's node names none.
  const pinned = { provider: request.provider, model: request.model ?? agentMeta?.model, reasoning: request.reasoning ?? agentMeta?.effort, service_tier: request.serviceTier };
  const row = roleRowOf(request.role);
  const author = await authorOf(rt, request.workflowRunId, row, pm);
  // Provider limits: the usage of both table providers is read first (bounded, never blocks), then the resolver moves a pick off a nearly spent one.
  const usage = spawnUsageOf({ bb: rt.ctx.bb, log: rt.ctx.log });
  await warmSpawnUsage(usage, hostId);
  // Only an observed refusal holds a provider out of the folder: the block this machine recorded on a real failed start.
  const folderBlockTtl = Number(settings["provider.folder_block_ttl_ms"]) || PROVIDER_FOLDER_BLOCK_TTL_MS;
  const blockStore = rt.ctx.bb.storage?.kv ?? { get: async () => null };
  const folderBlock = await readProviderFolderBlock(blockStore, hostId, folderBlockTtl);
  const resolvedChoice = resolveSpawnModel({ role: request.role, pinned, settings, pm, author, catalog: read, hostId, envPath, avoidProvider: avoid, usage, folderBlock });
  const smallPlan = pickPlanSmallModel({ form: request.form, nodeModel: request.nodeModel, role: request.role, chosen: resolvedChoice, author, catalog: read, hostId, envPath, folderBlock, settings });
  const chosen = smallPlan ? { ...resolvedChoice, ...smallPlan } : resolvedChoice;
  if (request.provider && providerBlockedForFolder(request.provider, envPath, folderBlock)) rt.ctx.log?.(`Lane Pilot: ${request.role} cannot run on ${request.provider} in ${envPath}: ${providerBlockedForFolder(request.provider, envPath, folderBlock)}; the role's next provider takes the step`);
  if (AUTHOR_ROW_IDS.includes(row)) await rememberAuthor(rt, request.workflowRunId, row, chosen);
  const where = `the ${request.role} of ${request.workflowId ?? "a workflow"}/${request.nodeId}`;
  if (chosen.issues.includes("crossed_family")) rt.ctx.log?.(`Lane Pilot: ${where} would have judged work of its own model family; it runs on ${chosen.providerId}/${chosen.model} (the other family)`);
  if (chosen.issues.includes("same_family_judge")) rt.ctx.log?.(`Lane Pilot: ${where} judges work of its own model family on ${chosen.providerId}/${chosen.model}: the other family has no model on this machine, so the judge is not independent`);
  if (chosen.issues.includes("model_unavailable_here") && read) {
    const on = findModelIn(read.providers.find((row) => row.id === chosen.providerId)?.models, chosen.model)?.hostIds.map((id) => read.hosts.find((row) => row.id === id)?.name ?? id).join(", ") ?? "";
    throw new HelperFailure("model_unavailable", `${chosen.providerId}/${chosen.model} is not offered by the machine this workflow's helpers run on (${read.hosts.find((row) => row.id === hostId)?.name ?? hostId})${on ? `; it is on ${on}` : ""}. Change the model of the role \"${request.role}\" in Settings (the role table).`);
  }
  if (chosen.issues.includes("escalated_for_role")) rt.ctx.log?.(`Lane Pilot: ${where} inherited a model too light for it; it runs on ${chosen.providerId}/${chosen.model} (the role's default)`);
  if (chosen.issues.includes("light_model_for_role")) rt.ctx.log?.(`Lane Pilot: ${where} runs on ${chosen.model}, a light model for that role, as the role table says`);
  rt.ctx.log?.(`wf.model node=${request.nodeId} source=${request.nodeModel ? "node" : chosen.source === "table" || chosen.source === "stage" ? "role" : "default"} model=${chosen.providerId}/${chosen.model}`);
  const modelResolution = assembleHelperModelResolution({ role: request.role, requested: request.modelResolution?.requested, providerId: request.provider, model: request.model, reasoningEffort: request.reasoning, serviceTier: request.serviceTier, chosen, hostId, reason: options.reason });
  return { ...request, provider: chosen.providerId, model: chosen.model, reasoning: chosen.reasoningEffort, resolved: true, modelResolution, ...(chosen.serviceTier ? { serviceTier: chosen.serviceTier } : {}) };
}
