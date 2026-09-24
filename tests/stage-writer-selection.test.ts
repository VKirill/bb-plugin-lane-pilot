import { describe, expect, it } from "vitest";
import { resolveStageWriterSelection } from "../src/stage-writer-selection";

const config = { writerProviderId: "codex", writerModel: "gpt-5.6-luna" };

describe("resolveStageWriterSelection", () => {
  it("uses stage keys as requested and effective when both are set", () => {
    const selection = resolveStageWriterSelection({
      settings: {
        "docs.provider": "critic",
        "docs.model": "critic-model",
        "writer.provider": "codex",
        "writer.model": "gpt-6-astra",
      },
      config,
      stageProviderKey: "docs.provider",
      stageModelKey: "docs.model",
    });
    expect(selection).toEqual({
      requestedProviderId: "critic",
      requestedModel: "critic-model",
      providerId: "critic",
      model: "critic-model",
      source: "stage",
    });
  });

  it("falls back to the live writer profile, not prototype writerModel", () => {
    const selection = resolveStageWriterSelection({
      settings: { "writer.provider": "codex", "writer.model": "gpt-6-astra" },
      config,
      stageProviderKey: "docs.provider",
      stageModelKey: "docs.model",
    });
    expect(selection).toEqual({
      requestedProviderId: "codex",
      requestedModel: "gpt-6-astra",
      providerId: "codex",
      model: "gpt-6-astra",
      source: "writer-profile",
    });
    expect(selection.model).not.toBe(config.writerModel);
  });

  it("uses prototype only when no stage or writer profile is set", () => {
    const selection = resolveStageWriterSelection({
      settings: {},
      config,
      stageProviderKey: "memory.provider",
      stageModelKey: "memory.model",
    });
    expect(selection).toEqual({
      requestedProviderId: "codex",
      requestedModel: "gpt-5.6-luna",
      providerId: "codex",
      model: "gpt-5.6-luna",
      source: "prototype",
    });
  });

  it("keeps a stage model and fills provider from the writer profile", () => {
    const selection = resolveStageWriterSelection({
      settings: { "night_review.model": "critic-model", "writer.provider": "codex", "writer.model": "gpt-6-astra" },
      config,
      stageProviderKey: "night_review.provider",
      stageModelKey: "night_review.model",
    });
    expect(selection).toMatchObject({
      requestedModel: "critic-model",
      model: "critic-model",
      providerId: "codex",
      source: "stage",
    });
  });
});
