import { describe, expect, it } from "vitest";
import { fallbackModelNames, writerFallbackSummaryText, type FallbackCatalog } from "../src/rooms/ui-shell/ui/tab-team";

const catalog: FallbackCatalog = {
  providers: [
    { id: "acp-opencode", models: [
      { id: "zai-coding-plan/glm-5.3-flash", model: "glm-5.3-flash", displayName: "GLM 5.3 Flash" },
      { id: "router9/ag/gemini-3.8-flash-high", model: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash high" },
    ] },
  ],
};

describe("writer row fallback summary", () => {
  it("names each model as the picker does, under its id or its model name", () => {
    const names = fallbackModelNames(catalog);
    expect(names.get("acp-opencode/zai-coding-plan/glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(names.get("acp-opencode/glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(fallbackModelNames(null).size).toBe(0);
  });

  it("joins the display names in slot order and leaves out trailing empty slots", () => {
    const names = fallbackModelNames(catalog);
    const glm = { providerId: "acp-opencode", model: "zai-coding-plan/glm-5.3-flash", reasoningLevel: "high" };
    const gemini = { providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoningLevel: "medium" };
    expect(writerFallbackSummaryText([glm, gemini, null], names)).toBe("GLM 5.3 Flash → Gemini 3.8 Flash high");
    expect(writerFallbackSummaryText([glm, null, null], names)).toBe("GLM 5.3 Flash");
  });

  it("keeps an off slot before a filled one as a dash", () => {
    const names = fallbackModelNames(catalog);
    const other = { providerId: "codex", model: "gpt-6", reasoningLevel: "high" };
    expect(writerFallbackSummaryText([null, other, null], names)).toBe("— → gpt-6");
  });

  it("shows the raw model id while the catalog does not list the model, and a dash when every slot is off", () => {
    const other = { providerId: "codex", model: "gpt-6", reasoningLevel: "high" };
    expect(writerFallbackSummaryText([other], fallbackModelNames(null))).toBe("gpt-6");
    expect(writerFallbackSummaryText([null, null, null], fallbackModelNames(catalog))).toBe("—");
  });
});
