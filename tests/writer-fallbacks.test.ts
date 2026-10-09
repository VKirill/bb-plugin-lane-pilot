import { describe, expect, it } from "vitest";
import { WRITER_FALLBACK_DEFAULTS, writerFallbackChain, writerFallbackSlots, writerFallbacks } from "../src/rooms/writer/writer-fallbacks";

describe("writer fallbacks", () => {
  it("defaults to GLM 5.3 Flash, then Gemini 3.8 high; an emptied slot is off", () => {
    expect(writerFallbacks({}).map((row) => row.model)).toEqual(["zai-coding-plan/glm-5.3-flash", "router9/ag/gemini-3.8-flash-high"]);
    expect(writerFallbacks({ "writer.fallback1.provider":"" })).toEqual([WRITER_FALLBACK_DEFAULTS[1]]);
    expect(writerFallbacks({ "writer.fallback2.provider":"codex", "writer.fallback2.model":"gpt-6", "writer.fallback2.reasoning_effort":"max" })[1])
      .toEqual({ providerId:"codex", model:"gpt-6", reasoningLevel:"max" });
  });

  it("ends with the PM's model and never repeats the writer's or another link", () => {
    const pm = { providerId:"claude-code", model:"claude-opus-5-5" };
    const chain = writerFallbackChain({ providerId:"acp-opencode", model:"zai-coding-plan/glm-5.3-flash" }, writerFallbacks({}), pm);
    expect(chain.map((row) => [row.model, row.pm])).toEqual([["router9/ag/gemini-3.8-flash-high", false], ["claude-opus-5-5", true]]);
    expect(writerFallbackChain(pm, [], pm)).toEqual([]);
  });

  it("fallback 3 is off by default and, once set, sits after fallbacks 1 and 2 and before the PM", () => {
    expect(writerFallbackSlots({})[2]).toBeNull();
    expect(writerFallbacks({})).toHaveLength(2);
    const settings = { "writer.fallback3.provider":"codex", "writer.fallback3.model":"gpt-6", "writer.fallback3.reasoning_effort":"high" };
    expect(writerFallbacks(settings).map((row) => row.model)).toEqual(["zai-coding-plan/glm-5.3-flash", "router9/ag/gemini-3.8-flash-high", "gpt-6"]);
    const pm = { providerId:"claude-code", model:"claude-opus-5-5" };
    const chain = writerFallbackChain({ providerId:"acp-opencode", model:"zai-coding-plan/glm-5.3-flash" }, writerFallbacks(settings), pm);
    expect(chain.map((row) => [row.model, row.pm])).toEqual([["router9/ag/gemini-3.8-flash-high", false], ["gpt-6", false], ["claude-opus-5-5", true]]);
  });

  it("an emptied fallback 3 is skipped and shows as off in the slot list", () => {
    const settings = { "writer.fallback3.provider":"", "writer.fallback2.provider":"codex", "writer.fallback2.model":"gpt-6", "writer.fallback2.reasoning_effort":"max" };
    expect(writerFallbackSlots(settings)).toEqual([WRITER_FALLBACK_DEFAULTS[0], { providerId:"codex", model:"gpt-6", reasoningLevel:"max" }, null]);
    expect(writerFallbacks(settings).map((row) => row.model)).toEqual(["zai-coding-plan/glm-5.3-flash", "gpt-6"]);
  });
});
