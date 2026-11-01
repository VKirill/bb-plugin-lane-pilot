import { describe, expect, it } from "vitest";
import { defaultModelIn } from "@lane-pilot/models";

// A PM chat on its provider's default model names no model (2026-11-01: the pair fell back to the writer's own, the chain
// deduplicated it away, and every limit of the writer read as «capacity_saturated»): the catalog's default is that model.
describe("defaultModelIn", () => {
  it("names the catalog's default model and null when none is marked", () => {
    expect(defaultModelIn([{ id: "opus", isDefault: false }, { id: "sonnet", isDefault: true }])).toBe("sonnet");
    expect(defaultModelIn([{ id: "opus" }])).toBeNull();
    expect(defaultModelIn(undefined)).toBeNull();
  });
});
