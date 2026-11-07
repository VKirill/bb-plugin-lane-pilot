;
import { casUpsertSettings, sectionBindingId } from "../../../storage";
import {PAIR_ROLE_SPECS, compatibleReasoningLevel, compatibleServiceTier, findModelIn, roleSpec, type PairRoleSelectionRpc, type RoleSpec, writerFallbackKeys} from "@lane-pilot/models";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";

import type { WriterHostApi } from "../../../writer/server/writer-host";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  selectionCatalog: WriterHostApi["selectionCatalog"];
  selectionCatalogHost: WriterHostApi["selectionCatalogHost"];
}

type ValidationCode = "invalid_choice" | "incompatible_setting" | "setup_required" | "writer_binding_ambiguous" | "writer_host_offline" | "catalog_unavailable";
type SelectionOutput = {
  ok: boolean;
  conflict: boolean;
  values: Record<string, unknown>;
  versions: Record<string, number>;
  validation?: { code: ValidationCode; key: string; params: string[] };
};
type PairInput = {
  projectId: string;
  sectionId?: string;
  threadId?: string | null;
  selectedBinding?: { hostId: string; path: string };
  providerId: string;
  model: string;
  reasoningLevel: string;
  serviceTier?: "default" | "fast" | null;
  expectedVersions: Record<string, number>;
};
type SelectionHandlerInput =
  | PairInput
  | { projectId: string; sectionId?: string; seat: string; providerId: string; model: string; reasoningLevel: string; expectedVersions: Record<string, number> }
  | { projectId: string; sectionId?: string; slot: number; off?: boolean; providerId?: string; model?: string; reasoningLevel?: string; expectedVersions: Record<string, number> };
type SelectionHandler = (input: SelectionHandlerInput) => Promise<SelectionOutput>;

export function selectionsRpc(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  const reject = (spec: RoleSpec, input: { projectId: string; sectionId?: string; providerId?: string; model?: string; reasoningLevel?: string }, code: ValidationCode, key: string, message: string): SelectionOutput => {
    // The writer's refusal is logged with its reason: the page shows it once, and a later look at why a pick «did not stick» has only the log.
    if (spec.log) bb.log.warn(`${spec.rpc} refused for ${input.projectId}${input.sectionId ? `/${input.sectionId}` : ""}: ${input.providerId}/${input.model} ${input.reasoningLevel}: ${code} ${key} ${message}`);
    return { ok: false, conflict: false, values: {}, versions: {}, validation: { code, key, params: [key, message] } };
  };
  /** The host whose catalog the pick is judged against, or the refusal that says why there is none. */
  const catalogHost = async (spec: RoleSpec, input: PairInput): Promise<{ hostId: string } | { output: SelectionOutput }> => {
    if (spec.host === "writer-binding") {
      const binding = await services.resolveProjectWriterHost({ projectId: input.projectId });
      if (binding.status === "catalog_unavailable") return { output: reject(spec, input, "catalog_unavailable", "project.sources", binding.reason) };
      if (binding.status === "setup_required") return { output: reject(spec, input, "setup_required", "project.sources", "project_folders_source_required") };
      if (binding.status === "ambiguous") return { output: reject(spec, input, "writer_binding_ambiguous", "project.sources", "select_existing_project_binding") };
      if (binding.status === "offline") return { output: reject(spec, input, "writer_host_offline", "project.sources", binding.hostId) };
      return { hostId: binding.hostId };
    }
    const host = await services.selectionCatalogHost(input.projectId, input.threadId, input.selectedBinding);
    if (host.ok) return { hostId: host.hostId };
    if (spec.remapValidation) return { output: reject(spec, input, host.validation.code, host.validation.key, host.validation.params[1] ?? "") };
    return { output: { ok: false, conflict: false, values: {}, versions: {}, validation: host.validation } };
  };

  /** The four keys of a `pair` role, saved together (packages/models/role-specs.ts). */
  const pairHandler = (spec: RoleSpec): SelectionHandler => async (raw) => {
    const input = raw as PairInput;
    const { projectId, sectionId, providerId, model: modelId, reasoningLevel, serviceTier, expectedVersions } = input;
    const prefix = spec.prefix!;
    const host = await catalogHost(spec, input);
    if ("output" in host) return host.output;
    let providers: Awaited<ReturnType<typeof bb.sdk.providers.list>>;
    let catalog: Awaited<ReturnType<typeof bb.sdk.providers.models>>;
    try {
      [providers, catalog] = await services.selectionCatalog(projectId, host.hostId, providerId);
    } catch {
      return reject(spec, input, "catalog_unavailable", `${prefix}.provider`, host.hostId);
    }
    const provider = providers.find((item) => item.id === providerId && item.available);
    if (!provider) return reject(spec, input, "invalid_choice", `${prefix}.provider`, `provider ${providerId} is unavailable on this host`);
    const selectedModel = findModelIn(catalog.models, modelId);
    if (!selectedModel) return reject(spec, input, "invalid_choice", `${prefix}.model`, `model ${modelId} is not in the live catalog for ${providerId}`);
    const supportedEfforts = selectedModel.supportedReasoningEfforts.map((item) => item.reasoningEffort);
    const catalogDefault = typeof selectedModel.defaultReasoningEffort === "string" ? selectedModel.defaultReasoningEffort : undefined;
    const selectedEffort = spec.effort === "compatible"
      ? compatibleReasoningLevel(reasoningLevel, supportedEfforts, catalogDefault)
      : supportedEfforts.includes(reasoningLevel) ? reasoningLevel : null;
    if (!selectedEffort) {
      const reason = spec.effort === "compatible"
        ? catalogDefault && !supportedEfforts.includes(catalogDefault)
          ? `malformed_catalog_defaultReasoningEffort:${catalogDefault}`
          : `model supports: ${supportedEfforts.join(", ") || "none"}`
        : `model supports: ${supportedEfforts.join(", ")}`;
      return reject(spec, input, "incompatible_setting", `${prefix}.reasoning_effort`, reason);
    }
    const supportedTiers = provider.serviceTiers?.map((tier) => tier.id) ?? [];
    const selectedTier = spec.tier === "compatible"
      ? compatibleServiceTier(serviceTier ?? null, supportedTiers)
      : serviceTier ?? (provider.capabilities.supportsServiceTier && supportedTiers.includes("default") ? "default" : null);
    const tierRefused = spec.tier === "compatible"
      ? Boolean(serviceTier && supportedTiers.length > 0 && !selectedTier)
      : selectedTier === "fast" && !supportedTiers.includes("fast");
    if (tierRefused) return reject(spec, input, "invalid_choice", `${prefix}.service_tier`, `provider supports: ${supportedTiers.join(", ") || "no service tiers"}`);
    // The writer pair's static catalog still lists the old adoc CLI enum; the live catalog check above is the real one.
    return casUpsertSettings(db, {
      projectId,
      bindingId: sectionId ? sectionBindingId(sectionId) : "",
      changes: [
        { key: `${prefix}.provider`, value: providerId, expectedVersion: expectedVersions[`${prefix}.provider`] },
        { key: `${prefix}.model`, value: modelId, expectedVersion: expectedVersions[`${prefix}.model`] },
        { key: `${prefix}.reasoning_effort`, value: selectedEffort, expectedVersion: expectedVersions[`${prefix}.reasoning_effort`] },
        { key: `${prefix}.service_tier`, value: selectedTier === "fast" ? "fast" : "standard", expectedVersion: expectedVersions[`${prefix}.service_tier`] },
      ],
    }, { skipValidationKeys: spec.id === "writer" ? spec.keys : [] });
  };

  const councilHandler = (spec: RoleSpec): SelectionHandler => async (raw) => {
    const { projectId, sectionId, seat, providerId, model: modelId, reasoningLevel, expectedVersions } = raw as Extract<SelectionHandlerInput, { seat: string }>;
    const keys = { provider: `council.${seat}.provider`, model: `council.${seat}.model`, effort: `council.${seat}.reasoning_effort` };
    const host = await services.selectionCatalogHost(projectId);
    if (!host.ok) return { ok: false, conflict: false, values: {}, versions: {}, validation: host.validation };
    let providers: Awaited<ReturnType<typeof bb.sdk.providers.list>>;
    let catalog: Awaited<ReturnType<typeof bb.sdk.providers.models>>;
    try {
      [providers, catalog] = await services.selectionCatalog(projectId, host.hostId, providerId);
    } catch {
      return reject(spec, { projectId, sectionId, providerId, model: modelId, reasoningLevel }, "catalog_unavailable", keys.provider, host.hostId);
    }
    if (!providers.find((item) => item.id === providerId && item.available)) return reject(spec, { projectId, sectionId, providerId, model: modelId, reasoningLevel }, "invalid_choice", keys.provider, `provider ${providerId} is unavailable on this host`);
    const selectedModel = catalog.models.find((item) => item.id === modelId || item.model === modelId);
    if (!selectedModel) return reject(spec, { projectId, sectionId, providerId, model: modelId, reasoningLevel }, "invalid_choice", keys.model, `model ${modelId} is not in the live catalog for ${providerId}`);
    const efforts = selectedModel.supportedReasoningEfforts.map((item) => item.reasoningEffort);
    if (!efforts.includes(reasoningLevel)) return reject(spec, { projectId, sectionId, providerId, model: modelId, reasoningLevel }, "incompatible_setting", keys.effort, `model supports: ${efforts.join(", ")}`);
    return casUpsertSettings(db, {
      projectId,
      bindingId: sectionId ? sectionBindingId(sectionId) : "",
      changes: [
        { key: keys.provider, value: providerId, expectedVersion: expectedVersions[keys.provider] ?? 0 },
        { key: keys.model, value: modelId, expectedVersion: expectedVersions[keys.model] ?? 0 },
        { key: keys.effort, value: reasoningLevel, expectedVersion: expectedVersions[keys.effort] ?? 0 },
      ],
    });
  };

  const fallbackHandler = (spec: RoleSpec): SelectionHandler => async (raw) => {
    const { projectId, sectionId, slot, off, providerId, model: modelId, reasoningLevel, expectedVersions } = raw as Extract<SelectionHandlerInput, { slot: number }>;
    const keys = writerFallbackKeys(slot);
    const store = (provider: string, model: string, effort: string) => casUpsertSettings(db, {
      projectId,
      bindingId: sectionId ? sectionBindingId(sectionId) : "",
      changes: [
        { key: keys.provider, value: provider, expectedVersion: expectedVersions[keys.provider] ?? 0 },
        { key: keys.model, value: model, expectedVersion: expectedVersions[keys.model] ?? 0 },
        { key: keys.effort, value: effort, expectedVersion: expectedVersions[keys.effort] ?? 0 },
      ],
    });
    const refuse = (code: ValidationCode, key: string, message: string) => reject(spec, { projectId, sectionId, providerId, model: modelId, reasoningLevel }, code, key, message);
    if (off) return store("", "", "");
    if (!providerId || !modelId || !reasoningLevel) return refuse("invalid_choice", keys.provider, "provider, model and reasoning level are required");
    const host = await services.selectionCatalogHost(projectId);
    if (!host.ok) return { ok: false, conflict: false, values: {}, versions: {}, validation: host.validation };
    let providers: Awaited<ReturnType<typeof bb.sdk.providers.list>>;
    let catalog: Awaited<ReturnType<typeof bb.sdk.providers.models>>;
    try {
      [providers, catalog] = await services.selectionCatalog(projectId, host.hostId, providerId);
    } catch {
      return refuse("catalog_unavailable", keys.provider, host.hostId);
    }
    if (!providers.find((item) => item.id === providerId && item.available)) return refuse("invalid_choice", keys.provider, `provider ${providerId} is unavailable on this host`);
    const selectedModel = catalog.models.find((item) => item.id === modelId || item.model === modelId);
    if (!selectedModel) return refuse("invalid_choice", keys.model, `model ${modelId} is not in the live catalog for ${providerId}`);
    const efforts = selectedModel.supportedReasoningEfforts.map((item) => item.reasoningEffort);
    if (!efforts.includes(reasoningLevel)) return refuse("incompatible_setting", keys.effort, `model supports: ${efforts.join(", ")}`);
    return store(providerId, modelId, reasoningLevel);
  };

  const pairHandlers = Object.fromEntries(PAIR_ROLE_SPECS.map((spec) => [spec.rpc, pairHandler(spec)])) as unknown as Record<PairRoleSelectionRpc, SelectionHandler>;
  return {
    ...pairHandlers,
    save_council_seat_selection: councilHandler(roleSpec("council")!),
    save_writer_fallback_selection: fallbackHandler(roleSpec("writer_fallback")!),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "save_council_seat_selection" | "save_writer_fallback_selection" | "save_writer_selection" | "save_memory_selection" | "save_night_review_selection" | "save_docs_selection" | "save_project_life_selection" | "save_pm_read_selection" | "save_onboarding_selection" | "save_plan_critique_selection" | "save_code_critique_selection" | "save_specialist_selection">;
}
