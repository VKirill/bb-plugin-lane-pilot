import { describe, expect, it } from "vitest";
import { compatibleReasoningLevel, compatibleServiceTier } from "../src/picker-compat";

describe("picker catalog remapping", () => {
  it("keeps an explicitly supported effort", () => {
    expect(compatibleReasoningLevel("high", ["high", "xhigh"], "xhigh")).toBe("high");
  });

  it("maps leftover low to the model's catalog defaultReasoningEffort", () => {
    expect(compatibleReasoningLevel("low", ["high", "xhigh"], "xhigh")).toBe("xhigh");
  });

  it("rejects when the catalog default is missing or not in the supported list", () => {
    expect(compatibleReasoningLevel("low", ["high", "xhigh"], undefined)).toBeNull();
    expect(compatibleReasoningLevel("low", ["high", "xhigh"], "medium")).toBeNull();
    expect(compatibleReasoningLevel("low", [], "xhigh")).toBeNull();
  });

  it("does not keep leftover fast on a default-only provider", () => {
    expect(compatibleServiceTier("fast", ["default"])).toBe("default");
    expect(compatibleServiceTier("fast", [])).toBeNull();
    expect(compatibleServiceTier("fast", ["fast"])).toBe("fast");
  });
});
