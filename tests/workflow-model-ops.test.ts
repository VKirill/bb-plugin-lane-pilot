import { describe, expect, it } from "vitest";
import { effortFor } from "../src/rooms/ui-shell/ui/model-choice";
import type { CatalogModel } from "@lane-pilot/models";

const codexModel: CatalogModel = { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", efforts: ["none", "low", "high", "ultra"], defaultEffort: "low", isDefault: false, hostIds: ["mac"] };
const openCodeModel: CatalogModel = { id: "gemini", model: "gemini", displayName: "Gemini", efforts: ["medium"], defaultEffort: "medium", isDefault: true, hostIds: ["mac"] };

describe("model choices of the native picker", () => {
  it("keeps a supported effort or falls back to the model default", () => {
    expect(effortFor(openCodeModel, "high")).toBe("medium");
    expect(effortFor(codexModel, "high")).toBe("high");
    expect(effortFor(codexModel, null)).toBe("low");
    expect(effortFor(undefined, "high")).toBeNull();
  });
});
