import { describe, expect, it } from "vitest";
import { choiceOps, choiceRefusal, clearModelOps, effortFor, firstChoice } from "../src/ui/workflow-model-ops";
import type { ModelCatalog } from "../src/workflow/model-catalog";

const catalog: ModelCatalog = {
  hosts: [{ id: "mac", name: "Mac mini", connected: true }],
  providers: [
    { id: "codex", displayName: "Codex", logoUrl: null, family: null, supportsServiceTier: true, serviceTiers: ["fast"], hostIds: ["mac"],
      models: [{ id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", efforts: ["none", "low", "high", "ultra"], defaultEffort: "low", isDefault: false, hostIds: ["mac"] }] },
    { id: "acp-opencode", displayName: "OpenCode", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mac"],
      models: [{ id: "deepseek/v4", model: "deepseek/v4", displayName: "DeepSeek V4", efforts: ["high"], defaultEffort: "high", isDefault: false, hostIds: [] }, { id: "gemini", model: "gemini", displayName: "Gemini", efforts: ["medium"], defaultEffort: "medium", isDefault: true, hostIds: ["mac"] }] },
  ],
};
const definition = { nodes: [{ id: "a", type: "agent", role: "analyst" }, { id: "fan", type: "parallel", child: { type: "agent", role: "analyst", model_preset: "cheap-fast" } }], edges: [] };

describe("model choices become draft patches", () => {
  it("sets provider, model and effort on the step, and clears them to hand the step back to its default", () => {
    expect(choiceOps(definition, catalog, "a", { providerId: "codex", model: "gpt-6-luna", effort: "high" })).toEqual({ ok: true, ops: [{ op: "update_node", id: "a", set: { provider: "codex", model: "gpt-6-luna", reasoning: "high" } }] });
    expect(clearModelOps(definition, "a")).toEqual([{ op: "update_node", id: "a", set: { provider: null, model: null, reasoning: null, service_tier: null } }]);
  });

  it("writes fast mode as `service_tier` only when the choice speaks of it, and refuses it where the provider has none", () => {
    expect(choiceOps(definition, catalog, "a", { providerId: "codex", model: "gpt-6-luna", effort: "low", serviceTier: "fast" })).toEqual({ ok: true, ops: [{ op: "update_node", id: "a", set: { provider: "codex", model: "gpt-6-luna", reasoning: "low", service_tier: "fast" } }] });
    expect(choiceOps(definition, catalog, "a", { providerId: "codex", model: "gpt-6-luna", effort: "low", serviceTier: "default" })).toMatchObject({ ok: true, ops: [{ set: { service_tier: null } }] });
    expect(choiceOps(definition, catalog, "a", { providerId: "acp-opencode", model: "gemini", serviceTier: "fast" })).toMatchObject({ ok: false, code: "tier_unsupported" });
  });

  it("writes the body of a parallel into its `child`, keeping the child's other fields", () => {
    expect(choiceOps(definition, catalog, "fan:child", { providerId: "codex", model: "gpt-6-luna" })).toEqual({ ok: true, ops: [{ op: "update_node", id: "fan", set: { child: { type: "agent", role: "analyst", model_preset: "cheap-fast", provider: "codex", model: "gpt-6-luna" } } }] });
    expect(clearModelOps(definition, "fan:child")![0]).toMatchObject({ set: { child: { type: "agent", role: "analyst", model_preset: "cheap-fast" } } });
    expect(choiceOps(definition, catalog, "gone", { providerId: "codex", model: "gpt-6-luna" })).toMatchObject({ ok: false, code: "no_node" });
    expect(clearModelOps(definition, "a:child")).toBeNull();
  });

  it("refuses what the catalog does not support, before any patch exists", () => {
    expect(choiceRefusal(catalog, { providerId: "acp-opencode", model: "deepseek/v4" })).toMatchObject({ code: "model_unavailable" });
    expect(choiceRefusal(catalog, { providerId: "codex", model: "gpt-6-luna", effort: "max" })).toMatchObject({ code: "effort_unsupported" });
    // `ultra` is something the model has and a workflow node cannot be given.
    expect(choiceRefusal(catalog, { providerId: "codex", model: "gpt-6-luna", effort: "ultra" })).toMatchObject({ code: "no_effort" });
    expect(choiceOps(definition, catalog, "a", { providerId: "nope", model: "x" })).toMatchObject({ ok: false, code: "provider_unknown" });
    expect(choiceRefusal(catalog, { providerId: "codex", model: "gpt-6-luna", effort: "low" })).toBeNull();
  });

  it("chooses a provider's first model that a machine has, with an effort the node can hold", () => {
    expect(firstChoice(catalog, "acp-opencode", "high")).toEqual({ providerId: "acp-opencode", model: "gemini", effort: "medium" });
    expect(firstChoice(catalog, "codex", "high")).toEqual({ providerId: "codex", model: "gpt-6-luna", effort: "high" });
    expect(firstChoice(catalog, "codex", null)).toEqual({ providerId: "codex", model: "gpt-6-luna", effort: "low" });
    expect(firstChoice(catalog, "nope", null)).toBeNull();
    expect(effortFor(undefined, "high")).toBeNull();
  });
});
