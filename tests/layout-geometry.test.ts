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
    expect(source).toContain("CONTROL_H");
    expect(source).toContain("<Disclosure");
    expect(source).not.toMatch(/<details /);
  });

  it("uses one Disclosure and matching control height on project settings", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/ui/page.tsx"), "utf8");
    expect(source).toContain("<Disclosure");
    expect(source).toContain("CONTROL_H");
    expect(source).toContain("settings-toolbar");
    expect(source).not.toMatch(/<details /);
    expect(source).not.toMatch(/size="sm" variant=\{settingsDepth/);
    expect(source).toContain("titleOnly");
    expect(source).toContain("mb-0 leading-5");
  });

  it("rotates only the summary chevron and keeps BB AlertTitle defaults", () => {
    const disclosure = readFileSync(join(import.meta.dirname, "../src/ui/disclosure.tsx"), "utf8");
    expect(disclosure).toContain("data-disclosure-chevron");
    expect(disclosure).toContain("[&[open]>summary_[data-disclosure-chevron]]:rotate-90");
    expect(disclosure).not.toContain("[&[open]_svg]:rotate-90");
    const alert = readFileSync(join(import.meta.dirname, "../components/ui/alert.tsx"), "utf8");
    expect(alert).toContain("mb-1 font-medium leading-none");
  });

  it("exposes panel descendant measurement, not only document width", () => {
    const measure = readFileSync(join(import.meta.dirname, "layout/geometry.js"), "utf8");
    expect(measure).toContain("controlOverflow");
    expect(measure).toContain("scrollWidth");
    expect(measure).toContain("fieldset");
    expect(measure).toContain("toolbarAligned");
  });
});
