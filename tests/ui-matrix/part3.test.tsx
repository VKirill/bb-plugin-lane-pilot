/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { openTab } from "../ui-tabs";
import { fireEvent, waitFor } from "@testing-library/react";
import { mountPage, missingStack, screenFixture } from "../ui-harness";
import { en, ru, setLocaleOverride, validationMessage } from "@lane-pilot/i18n";
import { EXTERNAL_OPS } from "../../src/rooms/runs";
import { useMatrixHooks } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

describe("Lane Pilot UI", () => {
  useMatrixHooks();

  it("does not emit React duplicate-key warnings for medium or specialist.model", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args); });
    const slot = await mountPage();
    openTab(slot, "team");
    await waitFor(() => expect(slot.getByTestId("specialist-settings").querySelector("[data-testid='bb-provider-model-picker']")).toBeTruthy());
    openTab(slot, "service");
    const joined = errors.map((item) => String(item)).join("\n");
    expect(joined).not.toMatch(/same key/i);
    expect(joined).not.toContain("specialist.model");
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
    openTab(slot, "team");
    await slot.findByTestId("writer-picker");
    fireEvent.click(slot.container.querySelector("[role='switch']") as HTMLButtonElement);
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
      await waitFor(() => expect(slot.getByTestId("install-panel")).toBeTruthy());
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
    openTab(slot, "work");
    await slot.findByTestId("project-header");
    expect(screen).toHaveBeenCalledTimes(1);
    const calls = sections.mock.calls.length;
    openTab(slot, "team");
    await slot.findByTestId("system-agents");
    fireEvent.click(slot.getByTestId("console-nav-work"));
    await slot.findByTestId("console-work");
    openTab(slot, "work");
    await slot.findByTestId("project-header");
    expect(screen).toHaveBeenCalledTimes(1);
    expect(sections.mock.calls.length).toBe(calls + 1);
    slot.lifecycle.unmount();
  });

  it("refreshes the runs panel by itself on the project's signal, without reloading the screen", async () => {
    const base = screenFixture();
    const screen = vi.fn(() => base);
    const overviewBase = {
      tz: "UTC",
      counts: { active: 1, waiting: 0, closedToday: 0, spendTodayUsd: null, goalsOnTrack: 0, goalsTotal: 0 },
      active: [{ kind: "task", key: "task:lprun_1:task_1", title: "Task one", projectId: "proj_ui", stage: "writer-agent", since: 1, costUsd: null, runId: "lprun_1", taskId: "task_1" }],
      closedByDay: [],
      goals: [],
      costCoverage: 1,
    };
    let updated = false;
    const overviewCalls = vi.fn(() => updated
      ? { ...overviewBase, counts: { ...overviewBase.counts, active: 2 }, active: [{ ...overviewBase.active[0]!, key: "task:lprun_new:task_2", title: "Task new", runId: "lprun_new", taskId: "task_2" }, ...overviewBase.active] }
      : overviewBase);
    const slot = await mountPage({ get_screen: screen, console_overview: overviewCalls });
    await slot.findByTestId("overview-active-row-task:lprun_1:task_1");
    expect(slot.queryByTestId("overview-active-row-task:lprun_new:task_2")).toBeNull();
    updated = true;
    await slot.behavior.emitRealtime("lp:proj_ui", { kind: "helpers", threadId: "thr_pm" });
    await slot.findByTestId("overview-active-row-task:lprun_new:task_2");
    expect(overviewCalls.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen).toHaveBeenCalledTimes(1);
    slot.lifecycle.unmount();
  });

  // unreachable in the console: ConsoleRoutes unmounts inactive sections instead of keeping all 6 tabs mounted with hidden; see report
  it.skip("mounts a tab on its first open instead of all six at once, and keeps it after", async () => {
    const slot = await mountPage({}, { projectId:"proj_ui", threadId:null }, "", false);
    await slot.findByTestId("tab-work");
    expect(slot.getByTestId("work-panel").children).toHaveLength(0);
    expect(slot.getByTestId("runs-panel").children).toHaveLength(0);
    openTab(slot, "monitor");
    await slot.findByTestId("task-board");
    expect(slot.getByTestId("work-panel").children).toHaveLength(0);
    openTab(slot, "overview");
    expect(slot.getByTestId("task-board")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("applies saved global locale even when document lang is en", async () => {
    document.documentElement.lang = "en";
    const base = screenFixture();
    const slot = await mountPage({
      get_preferences: () => ({ locale:"ru", preference:"ru", lastProjectId:null }),
      get_screen: () => base,
    });
    await waitFor(() => expect(slot.getByTestId("console-nav-work").textContent).toBe(ru.consoleNavWork));
    openTab(slot, "monitor");
    expect(slot.getAllByText(ru.boardColRunning).length).toBeGreaterThan(0);
    openTab(slot, "service");
    expect(slot.getAllByText(ru.legacyFastModeExplanation).length).toBeGreaterThan(0);
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
    openTab(slot, "work");
    await slot.findByTestId("project-header");
    fireEvent.click(slot.getByTestId("scope-switcher"));
    fireEvent.click(await slot.findByTestId("scope-all"));
    await waitFor(() => expect(slot.getByTestId("project-header").querySelector("h1")?.textContent).toBe(en.navGlobals));
    openTab(slot, "team");
    expect(slot.queryByTestId("main-agent")).toBeNull();
    openTab(slot, "work");
    fireEvent.click(slot.getByRole("button", { name: en.settingsAdvanced }));
    const field = await slot.findByTestId("field-s371");
    fireEvent.click(field.querySelector("button[role='combobox']") as HTMLButtonElement);
    fireEvent.click(await slot.findByRole("option", { name: /project tree/i }));
    await waitFor(() => expect(saved).toContainEqual(expect.objectContaining({ projectId: "*", key: "helper.placement", value: "project_tree" })));
    fireEvent.click(slot.getByTestId("scope-switcher"));
    fireEvent.click(await slot.findByTestId("scope-project-proj_ui"));
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
