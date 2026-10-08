import { describe, expect, it } from "vitest";
import { criticPairCandidates, pairApartFromWriter, type CriticCatalog } from "../src/rooms/critique/critic-pair";

const config = { pmProviderId: "claude-code", pmModel: "opus" };

/** A host catalog: provider -> models (each with the efforts it supports); a provider not listed is unavailable. */
function catalog(spec: Record<string, Record<string, string[]>>, tiers: string[] = []): CriticCatalog {
  return {
    provider: async (providerId) => spec[providerId] ? { id: providerId, available: true, supportsServiceTier: tiers.length > 0, serviceTiers: tiers } : null,
    models: async (providerId) => Object.entries(spec[providerId] ?? {}).map(([model, efforts]) => ({ id: model, model, efforts })),
  };
}

describe("code critic on another model than the writer", () => {
  it("lists the stage selections in order, then the PM pair, without repeats", () => {
    expect(criticPairCandidates({
      "plan_critique.provider": "codex", "plan_critique.model": "gpt",
      "specialist.provider": "codex", "specialist.model": "gpt",
      "night_review.provider": "opencode", "night_review.model": "glm",
      "pm_read.provider": "codex",
    }, config)).toEqual([
      { providerId: "codex", model: "gpt" }, { providerId: "opencode", model: "glm" }, { providerId: "claude-code", model: "opus" },
    ]);
  });

  it("keeps the critic's pair when it differs from the writer's", async () => {
    const result = await pairApartFromWriter({ current: { providerId: "codex", model: "gpt" }, writer: { providerId: "opencode", model: "glm" },
      candidates: [{ providerId: "claude-code", model: "opus" }], effort: "high", tier: "standard", catalog: catalog({ "claude-code": { opus: ["high"] } }) });
    expect(result).toEqual({ pair: { providerId: "codex", model: "gpt" }, changed: false });
  });

  it("takes the next candidate that the host catalog has and that supports the effort", async () => {
    const result = await pairApartFromWriter({ current: { providerId: "codex", model: "gpt" }, writer: { providerId: "codex", model: "gpt" },
      candidates: [{ providerId: "codex", model: "gpt" }, { providerId: "gone", model: "x" }, { providerId: "opencode", model: "nope" }, { providerId: "opencode", model: "low-only" }, { providerId: "claude-code", model: "opus" }],
      effort: "high", tier: "standard",
      catalog: catalog({ opencode: { "low-only": ["low"] }, "claude-code": { opus: ["high", "medium"] } }) });
    expect(result).toEqual({ pair: { providerId: "claude-code", model: "opus" }, changed: true });
  });

  it("keeps the writer's pair when no other pair exists, never blocking", async () => {
    const result = await pairApartFromWriter({ current: { providerId: "codex", model: "gpt" }, writer: { providerId: "codex", model: "gpt" },
      candidates: [{ providerId: "gone", model: "x" }], effort: "high", tier: "standard", catalog: catalog({}) });
    expect(result).toEqual({ pair: { providerId: "codex", model: "gpt" }, changed: false });
  });

  it("keeps the writer's pair when the catalog cannot be read", async () => {
    const broken: CriticCatalog = { provider: async () => { throw new Error("host offline"); }, models: async () => [] };
    const result = await pairApartFromWriter({ current: { providerId: "codex", model: "gpt" }, writer: { providerId: "codex", model: "gpt" },
      candidates: [{ providerId: "claude-code", model: "opus" }], effort: "high", tier: "standard", catalog: broken });
    expect(result.pair).toEqual({ providerId: "codex", model: "gpt" });
    expect(result.changed).toBe(false);
  });

  it("skips a pair whose provider has no service tier the critic needs", async () => {
    const result = await pairApartFromWriter({ current: { providerId: "codex", model: "gpt" }, writer: { providerId: "codex", model: "gpt" },
      candidates: [{ providerId: "claude-code", model: "opus" }], effort: "high", tier: "fast", catalog: catalog({ "claude-code": { opus: ["high"] } }, ["default"]) });
    expect(result.changed).toBe(false);
  });

  it("does nothing when the writer's pair is unknown", async () => {
    const result = await pairApartFromWriter({ current: { providerId: "codex", model: "gpt" }, writer: null,
      candidates: [{ providerId: "claude-code", model: "opus" }], effort: "high", tier: "standard", catalog: catalog({ "claude-code": { opus: ["high"] } }) });
    expect(result).toEqual({ pair: { providerId: "codex", model: "gpt" }, changed: false });
  });
});
