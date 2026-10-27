import { describe, expect, it } from "vitest";
import { criticAcrossFamilies, criticPairCandidates, pairApartFromWriter, roleSelection, type CriticCatalog } from "../src/rooms/critique/critic-pair";

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

describe("the pipeline stages take their model from the role table", () => {
  const hostCatalog = catalog({ codex: { "gpt-6.1-sol": ["high", "medium"], "gpt-6-luna": ["high"] }, "claude-code": { "claude-opus-5-5": ["high"], "claude-haiku-5-5": ["low"] } });
  const fallback = { providerId: "codex", model: "writer-model" };

  it("uses the code-critic row (GPT-6.1 Sol high) when the owner set nothing, the owner's row when there is one, and the old stage selection until then", async () => {
    expect(await roleSelection({ catalog: hostCatalog, settings: {}, role: "code-critic", fallback })).toEqual({ providerId: "codex", model: "gpt-6.1-sol", effort: "high", source: "default" });
    expect(await roleSelection({ catalog: hostCatalog, settings: { "role_model.code-critic": { model: "claude-opus-5-5" } }, role: "code-critic", fallback }))
      .toEqual({ providerId: "claude-code", model: "claude-opus-5-5", effort: "high", source: "table" });
    expect(await roleSelection({ catalog: hostCatalog, settings: { "code_critique.provider": "codex", "code_critique.model": "gpt-6-luna", "code_critique.reasoning_effort": "high" }, role: "code-critic", fallback }))
      .toMatchObject({ model: "gpt-6.1-sol", source: "default" });
    expect(await roleSelection({ catalog: hostCatalog, settings: { "pm_read.provider": "claude-code", "pm_read.model": "claude-haiku-5-5", "pm_read.reasoning_effort": "low" }, role: "pm-reader", fallback }))
      .toEqual({ providerId: "claude-code", model: "claude-haiku-5-5", effort: "low", source: "stage" });
  });

  it("gives way to what the stage ran on before when the host lacks the model or its effort, or cannot be read", async () => {
    const plain = catalog({ codex: { "writer-model": ["high"] } });
    expect(await roleSelection({ catalog: plain, settings: {}, role: "plan-critic", fallback })).toEqual({ ...fallback, effort: null, source: "fallback" });
    const noEffort = catalog({ codex: { "gpt-6.1-sol": ["low"] } });
    expect(await roleSelection({ catalog: noEffort, settings: {}, role: "plan-critic", fallback })).toMatchObject({ source: "fallback" });
    const broken: CriticCatalog = { provider: async () => { throw new Error("host offline"); }, models: async () => [] };
    expect(await roleSelection({ catalog: broken, settings: {}, role: "plan-critic", fallback })).toMatchObject({ ...fallback, source: "fallback" });
  });

  it("puts the code critic on the other family than the writer's: Claude writer, GPT critic; GPT writer, Claude critic", async () => {
    const sol = { providerId: "codex", model: "gpt-6.1-sol" };
    const opus = { providerId: "claude-code", model: "claude-opus-5-5" };
    const input = { effort: "high", tier: "standard" as const, catalog: hostCatalog };
    expect(await criticAcrossFamilies({ ...input, critic: sol, writer: { providerId: "claude-code", model: "claude-sonnet-5-5" } })).toEqual({ pair: sol, changed: false });
    expect(await criticAcrossFamilies({ ...input, critic: sol, writer: { providerId: "codex", model: "gpt-6-luna" } })).toEqual({ pair: opus, changed: true });
    // An owner who put the critic on Claude meets a Claude writer: the critic moves to GPT.
    expect(await criticAcrossFamilies({ ...input, critic: opus, writer: { providerId: "claude-code", model: "claude-haiku-5-5" } })).toEqual({ pair: sol, changed: true });
    // Another writer family (Composer) or no writer yet: the critic stays.
    expect(await criticAcrossFamilies({ ...input, critic: sol, writer: { providerId: "acp-cursor", model: "composer-2.5" } })).toEqual({ pair: sol, changed: false });
    expect(await criticAcrossFamilies({ ...input, critic: sol, writer: null })).toEqual({ pair: sol, changed: false });
  });

  it("keeps the critic when the host lacks the other family's model, and never blocks", async () => {
    const onlyCodex = catalog({ codex: { "gpt-6.1-sol": ["high"], "gpt-6-luna": ["high"] } });
    const sol = { providerId: "codex", model: "gpt-6.1-sol" };
    expect(await criticAcrossFamilies({ critic: sol, writer: { providerId: "codex", model: "gpt-6-luna" }, effort: "high", tier: "standard", catalog: onlyCodex })).toEqual({ pair: sol, changed: false });
    const broken: CriticCatalog = { provider: async () => { throw new Error("host offline"); }, models: async () => [] };
    expect(await criticAcrossFamilies({ critic: sol, writer: { providerId: "codex", model: "gpt-6-luna" }, effort: "high", tier: "standard", catalog: broken })).toEqual({ pair: sol, changed: false });
  });
});
