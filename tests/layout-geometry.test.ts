/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { Disclosure } from "../packages/ui-kit/src/ui/disclosure";
import { Alert, AlertTitle } from "../packages/ui-kit/src/ui/alert";
import { fileContaining, filesContaining } from "./support/source-text";

describe("layout geometry harness", () => {
  it("loads the full bundled prompt, not a stub", () => {
    const bundled = JSON.parse(readFileSync(join(import.meta.dirname, "../src/rooms/contracts/bundled-agents.json"), "utf8"));
    expect(bundled["dev-orchestrator"].prompt).toContain("Lane Pilot PM");
    expect(bundled["dev-orchestrator"].prompt).not.toContain("Boot solo");
    expect(bundled["dev-orchestrator"].prompt.length).toBeGreaterThan(400);
    expect(bundled["dev-orchestrator"].tools[0]).toContain("Agent(");
  });

  it("requires fieldset min-inline-size reset in Agents markup", () => {
    const source = fileContaining('id="agent-prompt"').text;
    expect(source).toContain("minInlineSize: 0");
    expect(source).toContain("min-w-0 max-w-full");
    expect(source).toContain("agentSavedUnknownHelp");
    expect(source).toContain("items-start");
    expect(source).toContain("CONTROL_H");
    expect(source).toContain("<Disclosure");
    expect(source).not.toMatch(/<details /);
  });

  it("uses one Disclosure and matching control height on project settings", () => {
    const source = fileContaining("titleOnly").text;
    const header = fileContaining("settings-depth").text;
    const service = filesContaining("<Disclosure", "src/rooms/runs");
    expect(service.length).toBeGreaterThan(0);
    expect(source).toContain("CONTROL_H");
    expect(header).not.toMatch(/<details /);
    expect(source).not.toMatch(/<details /);
    expect(source).not.toMatch(/size="sm" variant=\{settingsDepth/);
    expect(source).toContain("mb-0 leading-5");
  });

  it("rotates only the summary chevron and keeps BB AlertTitle defaults", () => {
    const { container, unmount } = render(createElement(Disclosure, { summary: "More", children: createElement("div") }));
    expect(container.querySelector("details")?.className).toContain("[&[open]>summary_[data-disclosure-chevron]]:rotate-90");
    expect(container.querySelector("details")?.className).not.toContain("[&[open]_svg]:rotate-90");
    expect(container.querySelector("[data-disclosure-chevron]")).toBeTruthy();
    unmount();
    const alert = render(createElement(Alert, null, createElement(AlertTitle, null, "t")));
    expect(alert.container.querySelector(".mb-1.font-medium.leading-none")).toBeTruthy();
    cleanup();
  });

  it("exposes panel descendant measurement, not only document width", () => {
    const measure = readFileSync(join(import.meta.dirname, "layout/geometry.js"), "utf8");
    expect(measure).toContain("controlOverflow");
    expect(measure).toContain("scrollWidth");
    expect(measure).toContain("fieldset");
    expect(measure).toContain("toolbarAligned");
  });
});
