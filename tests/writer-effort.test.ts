import { describe, expect, it } from "vitest";
import { bbServiceTier, resolveWriterReasoning, writerExecutionSelection, writerServiceTier } from "@lane-pilot/models";

describe("Lane Pilot writer effort", () => {
  it.each(["medium", "high", "xhigh"] as const)("forwards supported %s unchanged to explicit BB execution selection", (level) => {
    const selected = writerExecutionSelection("codex", "gpt-test", level, "fast");
    const decision = resolveWriterReasoning({ manualLevel:level, supportedLevels:new Set(["medium","high","xhigh"]) });
    expect(decision).toMatchObject({ requested:level, effective:level, fallbackReason:null });
    expect(selected).toMatchObject({ providerId:"codex", model:"gpt-test", reasoningLevel:level, serviceTier:"fast",
      executionInputSources:{ providerId:"explicit", model:"explicit", reasoningLevel:"explicit", serviceTier:"explicit" } });
  });

  it("migrates legacy fast mode into service tier without changing reasoning", () => {
    expect(writerServiceTier({ "writer.fast_mode":true })).toBe("fast");
    expect(writerServiceTier({ "writer.fast_mode":false })).toBe("standard");
    expect(writerServiceTier({ "writer.fast_mode":true, "writer.service_tier":"standard" })).toBe("standard");
    expect(bbServiceTier("standard")).toBe("default");
    expect(bbServiceTier("fast")).toBe("fast");
    expect(writerExecutionSelection("codex", "gpt-6-luna", "medium", "fast").reasoningLevel).toBe("medium");
  });

  it("clamps a manual effort the live catalog does not list to the nearest listed one", () => {
    // Drill 2026-11-12: devin/swe-2-flash-medium listed only medium for a high writer, and every task was refused.
    expect(resolveWriterReasoning({ manualLevel:"high", supportedLevels:new Set(["medium"]) }))
      .toMatchObject({ effective:"medium", fallbackReason:"manual_effort_clamped:high->medium", manualSupported:false });
    expect(resolveWriterReasoning({ manualLevel:"medium", supportedLevels:new Set(["low", "high"]) }).effective).toBe("high");
    expect(resolveWriterReasoning({ manualLevel:"turbo", supportedLevels:new Set(["medium"]) }))
      .toMatchObject({ effective:"turbo", manualSupported:false });
    expect(resolveWriterReasoning({ manualLevel:"high", supportedLevels:null }))
      .toMatchObject({ effective:"high", fallbackReason:"selected_model_catalog_unavailable", manualSupported:null });
  });
});
