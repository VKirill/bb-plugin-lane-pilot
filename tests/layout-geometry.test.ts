import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("layout geometry harness", () => {
  it("loads the full bundled prompt, not a stub", () => {
    const bundled = JSON.parse(readFileSync(join(import.meta.dirname, "../src/bundled-agents.json"), "utf8"));
    expect(bundled["dev-orchestrator"].prompt.length).toBeGreaterThan(8000);
    expect(bundled["dev-orchestrator"].tools[0]).toContain("Agent(");
  });

  it("requires fieldset min-inline-size reset in Agents markup", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/ui/owned-settings.tsx"), "utf8");
    expect(source).toContain("minInlineSize: 0");
    expect(source).toContain("min-w-0 max-w-full");
    expect(source).toContain('id="agent-prompt"');
    expect(source).toContain("agentSavedUnknownHelp");
    expect(source).toContain("items-start");
  });

  it("exposes panel descendant measurement, not only document width", () => {
    const measure = readFileSync(join(import.meta.dirname, "layout/geometry.js"), "utf8");
    expect(measure).toContain("controlOverflow");
    expect(measure).toContain("scrollWidth");
    expect(measure).toContain("fieldset");
  });
});
