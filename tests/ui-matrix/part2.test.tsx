/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { openTab } from "../ui-tabs";
import { fireEvent, waitFor } from "@testing-library/react";
import { mountPage } from "../ui-harness";
import { VISIBLE_CATALOG, DISABLED_IDS, EDITABLE_IDS } from "@lane-pilot/settings-catalog";
import { en, ru, setLocaleOverride, t } from "@lane-pilot/i18n";
import { useMatrixHooks } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

describe("Lane Pilot UI", () => {
  useMatrixHooks();

  it("keeps technical fields in Diagnostics and renders each storage key once", async () => {
    const slot = await mountPage();
    expect(slot.queryByTestId("field-s004")).toBeNull();
    expect(slot.getByTestId("work-panel").textContent).not.toContain("CAS version");
    expect(slot.getByTestId("work-panel").textContent).not.toContain("--writer-provider");
    expect(slot.getByTestId("work-panel").querySelector("[data-storage-key='adoc.177']")).toBeNull();
    expect(slot.getByTestId("work-panel").querySelector("[data-storage-key='adoc.166']")).toBeNull();
    expect(slot.getByTestId("pm-read-settings")).toBeTruthy();
    // The critics' model rows live in the Team table now.
    openTab(slot, "team");
    expect(slot.getByTestId("plan-critique-settings")).toBeTruthy();
    expect(slot.getByTestId("plan-critique-settings").textContent).not.toContain("plan_critique.agent");
    expect(slot.getByTestId("plan-critique-settings").textContent).not.toMatch(/dispatch|changes_requested/);
    expect(slot.getByTestId("code-critique-settings")).toBeTruthy();
    openTab(slot, "work");
    expect(slot.getByTestId("work-panel").textContent).not.toContain(`${en.fieldDefault}:`);
    expect(slot.getByTestId("work-panel").textContent).not.toContain(`${en.fieldEffective}:`);
    fireEvent.click(slot.getByTestId("help-pm_read.min_lines"));
    expect(slot.getByTestId("help-dialog-pm_read.min_lines").textContent).toContain(en.largeFileThresholdHelp);
    openTab(slot, "service");
    const fields = Array.from(slot.getByTestId("diagnostics-panel").querySelectorAll<HTMLElement>("[data-storage-key]"));
    const keys = fields.map((node) => node.getAttribute("data-storage-key"));
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("writer.fast_mode");
    expect(slot.getByTestId("field-s024").textContent).toContain(en.legacyFastModeExplanation);
    expect(slot.getByTestId("compat-aliases")).toBeTruthy();
    expect(slot.getByTestId("compat-adoc.177").querySelector("input,button[role='combobox'],button[role='switch']")).toBeNull();
    expect(EDITABLE_IDS.length + DISABLED_IDS.length).toBe(VISIBLE_CATALOG.length);
    slot.lifecycle.unmount();
  });

  it("switches all chrome strings when document lang is ru", async () => {
    setLocaleOverride("en");
    document.documentElement.lang = "en";
    expect(t("tabSettings")).toBe(en.tabSettings);
    setLocaleOverride(null);
    Object.defineProperty(navigator, "language", { configurable: true, value: "ru-RU" });
    document.documentElement.lang = "ru";
    expect(t("tabSettings")).toBe(ru.tabSettings);
    expect(t("confirmBody")).toBe(ru.confirmBody);
    const slot = await mountPage();
    expect(slot.getByTestId("tab-overview").textContent).toBe(ru.tabOverview);
    expect(slot.getByTestId("tab-team").textContent).toBe(ru.tabTeam);
    expect(slot.getByTestId("tab-work").textContent).toBe(ru.tabWork);
    expect(slot.getByTestId("tab-knowledge").textContent).toBe(ru.tabKnowledge);
    expect(slot.getByTestId("tab-automation").textContent).toBe(ru.tabAutomation);
    expect(slot.getByTestId("tab-runs").textContent).toBe(ru.tabRuns);
    slot.lifecycle.unmount();
  });

  it("lists connect-specific operations instead of install.sh commands", async () => {
    const slot = await mountPage();
    openTab(slot, "service");
    fireEvent.click(await slot.findByTestId("stack-detect"));
    fireEvent.click(await slot.findByTestId("connect-opencode"));
    const dialog = await slot.findByTestId("external-ops-dialog");
    expect(dialog.textContent).toContain(en.confirmConnectOps);
    expect(dialog.textContent).not.toContain("npm install -g @rama_nigg/open-cursor");
    slot.lifecycle.unmount();
  });

  it("the project's «Tasks» tab is the rail's board locked to the project: no project switch, no table, the task on its column", async () => {
    const slot = await mountPage();
    openTab(slot, "monitor");
    await waitFor(() => expect(slot.getByTestId("runs-panel").hidden).toBe(false));
    await slot.findByTestId("task-board");
    expect(slot.queryByTestId("board-project")).toBeNull();
    expect(slot.getByTestId("run-monitor").querySelector("table")).toBeNull();
    expect((await slot.findByTestId("board-col-running")).textContent).toContain("Task one");
    slot.lifecycle.unmount();
  });

  it("shows persisted stage receipts with translated stage labels", async () => {
    setLocaleOverride("en");
    const slot = await mountPage();
    openTab(slot, "monitor");
    fireEvent.click(await slot.findByTestId("board-card-task:lprun_1:task_1"));
    const card = await slot.findByTestId("stage-receipts-lprun_1");
    expect(card.textContent).toContain("(1)");
    fireEvent.click(card.querySelector("summary")!);
    await waitFor(() => expect(card.textContent).toContain(en.stagePlanCritique));
    expect(card.textContent).toContain(en.stagePlanCritique);
    expect(card.textContent).toContain(en.state_passed);
    expect(card.textContent).not.toContain("Plan checked");
    fireEvent.click(slot.getByTestId("stage-result-lprun_1-task_1-plan-critique").querySelector("summary")!);
    await waitFor(() => expect(card.textContent).toContain("Plan checked"));

    slot.lifecycle.unmount();
    const russian = await mountPage({ get_preferences: () => ({ locale:"ru", preference:"ru", lastProjectId:"proj_ui" }) });
    await russian.findByTestId("tab-runs");
    await russian.findByTestId("tab-runs");
    openTab(russian, "monitor");
    fireEvent.click(await russian.findByTestId("board-card-task:lprun_1:task_1"));
    fireEvent.click((await russian.findByTestId("stage-receipts-lprun_1")).querySelector("summary")!);
    await waitFor(() => expect(russian.getByTestId("stage-receipts-lprun_1").textContent).toContain(ru.stagePlanCritique));
    russian.lifecycle.unmount();
    setLocaleOverride(null);
  });

  it("«Resume» lives in Maintenance and asks the server to pick up the project's stopped runs", async () => {
    const resume = vi.fn(() => ({ resumed: [], skipped: [], finished: [] }));
    const slot = await mountPage({ resume_runs: resume });
    openTab(slot, "runs", "service");
    const block = await slot.findByTestId("runs-resume");
    fireEvent.click(block.querySelector("button")!);
    await waitFor(() => expect(resume).toHaveBeenCalledWith({ projectId: "proj_ui" }));
    slot.lifecycle.unmount();
  });
});
