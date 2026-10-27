import { describe, expect, it } from "vitest";
import { effortFor, firstChoice } from "../src/rooms/workflow/ui/workflow-model-ops";
import type { ModelCatalog } from "@lane-pilot/models";

const catalog: ModelCatalog = {
  hosts: [{ id: "mac", name: "Mac mini", connected: true }],
  providers: [
    { id: "codex", displayName: "Codex", logoUrl: null, family: null, supportsServiceTier: true, serviceTiers: ["fast"], hostIds: ["mac"],
      models: [{ id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", efforts: ["none", "low", "high", "ultra"], defaultEffort: "low", isDefault: false, hostIds: ["mac"] }] },
    { id: "acp-opencode", displayName: "OpenCode", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mac"],
      models: [{ id: "deepseek/v4", model: "deepseek/v4", displayName: "DeepSeek V4", efforts: ["high"], defaultEffort: "high", isDefault: false, hostIds: [] }, { id: "gemini", model: "gemini", displayName: "Gemini", efforts: ["medium"], defaultEffort: "medium", isDefault: true, hostIds: ["mac"] }] },
  ],
};
describe("model choices of the native picker", () => {
  it("chooses a provider's first model that a machine has, with an effort the node can hold", () => {
    expect(firstChoice(catalog, "acp-opencode", "high")).toEqual({ providerId: "acp-opencode", model: "gemini", effort: "medium" });
    expect(firstChoice(catalog, "codex", "high")).toEqual({ providerId: "codex", model: "gpt-6-luna", effort: "high" });
    expect(firstChoice(catalog, "codex", null)).toEqual({ providerId: "codex", model: "gpt-6-luna", effort: "low" });
    expect(firstChoice(catalog, "nope", null)).toBeNull();
    expect(effortFor(undefined, "high")).toBeNull();
  });
});
