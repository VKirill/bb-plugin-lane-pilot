/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { Disclosure } from "../packages/ui-kit/src/ui/disclosure";
import { Alert, AlertTitle } from "../packages/ui-kit/src/ui/alert";
import { mountPage } from "./ui-harness";
import { openTab } from "./ui-tabs";

afterEach(() => { cleanup(); document.body.innerHTML = ""; });

describe("layout geometry harness", () => {
  it("loads the full bundled prompt, not a stub", () => {
    const bundled = JSON.parse(readFileSync(join(import.meta.dirname, "../src/rooms/contracts/bundled-agents.json"), "utf8"));
    expect(bundled["dev-orchestrator"].prompt).toContain("Lane Pilot PM");
    expect(bundled["dev-orchestrator"].prompt).not.toContain("Boot solo");
    expect(bundled["dev-orchestrator"].prompt.length).toBeGreaterThan(400);
    expect(bundled["dev-orchestrator"].tools[0]).toContain("Agent(");
  });

  it("requires fieldset min-inline-size reset in Agents markup", async () => {
    const slot = await mountPage({
      get_globals: () => ({
        defaults: {},
        revision: 0,
        agents: [{ id: "dev-orchestrator", description: "Dev", prompt: "Help", sourceHash: "abc", sourceVersion: "lp-owned-1" }],
      }),
      get_agent_inventory: () => ({
        skills: { status: "ready", items: [] },
        mcpServers: { status: "ready", items: [] },
        tools: { status: "ready", items: [] },
        disallowedTools: { status: "ready", items: [] },
      }),
    });
    fireEvent.click(await slot.findByTestId("console-nav-system-agents"));
    await waitFor(() => expect(slot.container.querySelector("#agent-prompt")).toBeTruthy());
    const prompt = slot.container.querySelector("#agent-prompt") as HTMLElement;
    const fieldset = prompt.closest("fieldset") as HTMLFieldSetElement;
    expect(fieldset.style.minInlineSize).toBe("0");
    expect(fieldset.className).toContain("min-w-0");
    expect(fieldset.className).toContain("max-w-full");
    expect(fieldset.querySelector(".items-start")).toBeTruthy();
    expect(slot.container.querySelector("#agent-description")?.className).toContain("h-9");
    const details = Array.from(fieldset.querySelectorAll("details"));
    expect(details.length).toBeGreaterThan(0);
    for (const d of details) expect(d.querySelector("[data-disclosure-chevron]")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("uses one Disclosure and matching control height on project settings", async () => {
    const slot = await mountPage({
      save_setting: () => ({
        ok: false, conflict: false, version: 1, value: false,
        validation: { code: "setup_required", key: "writer.provider", params: [] },
      }),
    });
    openTab(slot, "team");
    const sw = await waitFor(() => {
      const el = slot.container.querySelector("[role='switch']") as HTMLButtonElement | null;
      if (!el) throw new Error("switch not rendered");
      return el;
    });
    fireEvent.click(sw);
    const err = await slot.findByTestId("setting-validation-error");
    const title = err.querySelector("h5") ?? err.firstElementChild;
    expect(title?.className).toContain("mb-0");
    expect(title?.className).toContain("leading-5");
    expect(err.querySelector("button")).toBeNull();

    openTab(slot, "work");
    const levelPicker = slot.getByTestId("seg-settings-level-picker");
    for (const btn of Array.from(levelPicker.querySelectorAll("button"))) {
      expect(btn.className).toContain("h-[1.875rem]");
    }
    openTab(slot, "service");
    await waitFor(() => expect(slot.container.querySelectorAll("details").length).toBeGreaterThan(0));
    for (const d of Array.from(slot.container.querySelectorAll("details"))) {
      expect(d.querySelector("[data-disclosure-chevron]")).toBeTruthy();
    }
    slot.lifecycle.unmount();
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
