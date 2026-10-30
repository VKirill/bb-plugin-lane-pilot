import { describe, expect, it } from "vitest";
import { memoryMaintenancePrompt, parseMemorySettings } from "../../packages/memory-core/src";

describe("knowledge owners", () => {
  it("names one owner for each kind of knowledge", () => {
    const prompt = memoryMaintenancePrompt({ task: {}, acceptedResult: {}, settings: parseMemorySettings({}) });
    expect(prompt).toContain("Anamnesis owns owner facts");
    expect(prompt).toContain("Lane Pilot memory owns project technical facts and rules");
    expect(prompt).toContain("BB memory is the preference index");
    expect(prompt).toContain("Agentmemory is an observation archive");
    expect(prompt).toContain("Code and docs stay the source of behavior");
  });
});
