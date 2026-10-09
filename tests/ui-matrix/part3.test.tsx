/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { openTab } from "../ui-tabs";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { mountPage, missingStack, screenFixture } from "../ui-harness";
import { en, ru, setLocaleOverride, validationMessage } from "@lane-pilot/i18n";
import { EXTERNAL_OPS } from "../../src/rooms/runs/constants";
import { openRole, useMatrixHooks } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

describe("Lane Pilot UI", () => {
  useMatrixHooks();

  it("does not emit React duplicate-key warnings for medium or night_review.model", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args); });
    const slot = await mountPage();
    await waitFor(() => expect(slot.getByTestId("night-review-settings").querySelector("[data-testid='bb-provider-model-picker']")).toBeTruthy());
    openTab(slot, "service");
    const joined = errors.map((item) => String(item)).join("\n");
    expect(joined).not.toMatch(/same key/i);
    expect(joined).not.toContain("night_review.model");
    expect(joined).not.toMatch(/key=["']medium["']/i);
    spy.mockRestore();
    slot.lifecycle.unmount();
  });

  it("shows validation separately from CAS and localizes the allowed values", async () => {
    Object.defineProperty(navigator, "language", { configurable: true, value: "ru-RU" });
    setLocaleOverride(null);
    document.documentElement.lang = "ru";
    expect(validationMessage("invalid_choice", ["writer.provider", "agy, codex"]))
      .toBe(ru.validationInvalidChoice.replace("{key}", "writer.provider").replace("{allowed}", "agy, codex"));
    expect(validationMessage("incompatible_setting", ["writer.reasoning_effort", "writer.provider", "qwen", "low, medium, high"]))
      .toBe(ru.validationIncompatibleSetting.replace("{key}", "writer.reasoning_effort").replace("{otherKey}", "writer.provider").replace("{value}", "qwen").replace("{allowed}", "low, medium, high"));
    const slot = await mountPage({
      save_setting: () => ({ ok: false, conflict: false, version: 1, value: false, validation: {
        code: "invalid_choice", key: "writer.provider", params: ["writer.provider", "agy, grok, qwen"],
      } }),
    });
    await slot.findByTestId("writer-picker");
    fireEvent.click(openRole(slot, "writer").querySelector("[data-testid='jev-settings'] [role='switch']") as HTMLButtonElement);
    await slot.findByTestId("setting-validation-error");
    expect(slot.getByText(ru.validationInvalidChoice.replace("{key}", "writer.provider").replace("{allowed}", "agy, grok, qwen"))).toBeTruthy();
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows stack detection details in English and Russian", async () => {
    for (const locale of ["en", "ru"] as const) {
      const slot = await mountPage({
        get_preferences: () => ({ locale, preference:locale, lastProjectId:null }),
      });
      openTab(slot, "service");
      openTab(slot, "service");
      await waitFor(() => expect(slot.getByTestId("install-panel").hidden).toBe(false));
      fireEvent.click(slot.getByText(locale === "ru" ? ru.detect : en.detect));
      const result = await slot.findByTestId("stack-detect-result");
      expect(result.textContent).toContain(locale === "ru" ? ru.detectScenario : en.detectScenario);
      expect(result.textContent).toContain("S1");
      expect(result.textContent).toContain("1.38.0");
      expect(result.textContent).toContain("1.18.30");
      expect(result.textContent).not.toContain("/tmp/lane-pilot-ui");
      expect(result.textContent).not.toContain("/tmp/snapshot");
      openTab(slot, "service");
      expect(slot.getByTestId("import-diagnostics").textContent).toContain("/tmp/lane-pilot-ui");
      expect(slot.getByTestId("import-diagnostics").textContent).toContain("/tmp/snapshot");
      expect(slot.getByTestId("restore-previous-install").textContent).toContain(locale === "ru" ? ru.restorePreviousInstall : en.restorePreviousInstall);
      expect(slot.getByTestId("restore-previous-install").querySelectorAll("label").length).toBe(1);
      slot.lifecycle.unmount();
    }
  });

  it("does not reload the project screen when the Agents scope is opened and left again", async () => {
    const screen = vi.fn(() => screenFixture());
    const sections = vi.fn(() => ({ sections: [] }));
    const slot = await mountPage({ get_screen: screen, list_sections: sections }, { projectId:"proj_ui", threadId:null }, "", false);
    await slot.findByTestId("status-writer");
    expect(screen).toHaveBeenCalledTimes(1);
    const calls = sections.mock.calls.length;
    fireEvent.click(within(slot.getByTestId("scope-rail")).getByRole("tab", { name: en.navAgents }));
    fireEvent.click(slot.getByTestId("project-item-proj_ui"));
    await slot.findByTestId("status-writer");
    expect(screen).toHaveBeenCalledTimes(1);
    expect(sections.mock.calls.length).toBe(calls + 1);
    slot.lifecycle.unmount();
  });

  it("refreshes the runs panel by itself on the project's signal, without reloading the screen", async () => {
    const base = screenFixture();
    const screen = vi.fn(() => base);
    const listed = { runs: [{ ...base.runs[0]!, id: "lprun_new", state: "running", updated_at: 99, attempts: [], stageCount: 0 }, ...base.runs], total: 2 };
    const listRuns = vi.fn(() => listed);
    const slot = await mountPage({ get_screen: screen, list_runs: listRuns });
    openTab(slot, "monitor");
    await slot.findByTestId("run-lprun_1");
    expect(slot.queryByTestId("run-lprun_new")).toBeNull();
    await slot.behavior.emitRealtime("lp:proj_ui", { kind: "helpers", threadId: "thr_pm" });
    await slot.findByTestId("run-lprun_new");
    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_ui", offset: 0, pinOpen: true }));
    expect(screen).toHaveBeenCalledTimes(1);
    slot.lifecycle.unmount();
  });

  it("mounts a tab on its first open instead of all six at once, and keeps it after", async () => {
    const slot = await mountPage({}, { projectId:"proj_ui", threadId:null }, "", false);
    await slot.findByTestId("tab-work");
    expect(slot.getByTestId("work-panel").children).toHaveLength(0);
    expect(slot.getByTestId("runs-panel").children).toHaveLength(0);
    openTab(slot, "monitor");
    await slot.findByTestId("run-list");
    expect(slot.getByTestId("work-panel").children).toHaveLength(0);
    openTab(slot, "overview");
    expect(slot.getByTestId("run-list")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("applies saved global locale even when document lang is en", async () => {
    document.documentElement.lang = "en";
    const base = screenFixture();
    const slot = await mountPage({
      get_preferences: () => ({ locale:"ru", preference:"ru", lastProjectId:null }),
      get_screen: () => base,
    });
    await waitFor(() => expect(slot.getByTestId("tab-work").textContent).toBe(ru.tabWork));
    openTab(slot, "monitor");
    expect(slot.getAllByText(ru.state_running).length).toBeGreaterThan(0);
    openTab(slot, "service");
    expect(slot.getAllByText(new RegExp(ru.unappliedNoChannel)).length).toBeGreaterThan(0);
    slot.lifecycle.unmount();
  });

  it("edits the global level with the project panel and reloads projects after leaving it", async () => {
    let globalPlacement = "plugin";
    const saved: Array<{ projectId: string; key: string; value: unknown }> = [];
    const slot = await mountPage({
      get_screen: ({ projectId }: any) => {
        const payload = screenFixture(), global = projectId === "*";
        return { ...payload, projectId, values: { ...payload.values, "helper.placement": globalPlacement }, versions: { ...payload.versions, "helper.placement": global ? 1 : 0 }, inheritedKeys: global ? [] : ["helper.placement"] };
      },
      save_setting: (input: any) => {
        saved.push(input);
        if (input.projectId === "*" && input.key === "helper.placement") globalPlacement = input.value;
        return { ok: true, conflict: false, version: input.expectedVersion + 1, value: input.value };
      },
    });
    await slot.findByTestId("status-writer");
    fireEvent.click(slot.getAllByRole("tab", { name: "General settings" })[0]!);
    await waitFor(() => expect(slot.getByTestId("project-settings").querySelector("h1")?.textContent).toBe("General settings"));
    // The system level has the same six tabs; runs belong to projects, the language to the system.
    expect(slot.getByTestId("tab-runs")).toBeTruthy();
    expect(slot.queryByTestId("main-agent")).toBeNull();
    expect(slot.getByTestId("language-setting")).toBeTruthy();
    openTab(slot, "runs");
    expect(slot.getByTestId("runs-global-empty")).toBeTruthy();
    openTab(slot, "work");
    fireEvent.click(slot.getByRole("button", { name: en.settingsAdvanced }));
    const field = await slot.findByTestId("field-s371");
    fireEvent.click(field.querySelector("button[role='combobox']") as HTMLButtonElement);
    fireEvent.click(await slot.findByRole("option", { name: /project tree/i }));
    await waitFor(() => expect(saved).toContainEqual(expect.objectContaining({ projectId: "*", key: "helper.placement", value: "project_tree" })));
    fireEvent.click(slot.getByTestId("project-item-proj_ui"));
    await waitFor(() => expect(slot.getByTestId("field-s371").textContent).toContain("project tree"));
    expect(slot.getByTestId("field-s371").textContent).toContain("Inherited");
    slot.lifecycle.unmount();
  });

  it("keeps the confirm dialog title and full install ops list in the DOM", async () => {
    const slot = await mountPage({ stack_detect: missingStack });
    openTab(slot, "service");
    fireEvent.click(await slot.findByTestId("stack-detect"));
    fireEvent.click(await slot.findByTestId("install-stack"));
    const dialog = await slot.findByTestId("external-ops-dialog");
    expect(dialog.textContent).toContain(en.confirmTitle);
    for (const op of EXTERNAL_OPS) {
      expect(dialog.textContent).toContain(op);
    }
    slot.lifecycle.unmount();
  });
});
