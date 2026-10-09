/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { openTab } from "../ui-tabs";
import { fireEvent, waitFor } from "@testing-library/react";
import { mountPage, screenFixture } from "../ui-harness";
import { VISIBLE_CATALOG, DISABLED_IDS, EDITABLE_IDS } from "@lane-pilot/settings-catalog";
import { en, ru, setLocaleOverride, t } from "@lane-pilot/i18n";
import { toast } from "sonner";
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

  it("shows one card per run with its attempts inside, the same on every width", async () => {
    const slot = await mountPage();
    openTab(slot, "monitor");
    await waitFor(() => expect(slot.getByTestId("runs-panel").hidden).toBe(false));
    const card = await slot.findByTestId("run-lprun_1");
    expect(card.querySelector('[data-testid="attempt-lpattempt_1"]')).not.toBeNull();
    expect(slot.getByTestId("run-monitor").querySelector("table")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("fetches older runs page by page when the screen holds only the newest ones", async () => {
    const base = screenFixture();
    const run = (id: string, updated: number) => ({ ...base.runs[0]!, id, state: "closed", updated_at: updated, attempts: [], stageCount: 0 });
    (base as { runsTotal?: number; runsLimit?: number }).runsTotal = 3;
    (base as { runsTotal?: number; runsLimit?: number }).runsLimit = 2;
    base.runs = [run("lprun_n1", 30), run("lprun_n2", 20)];
    const listRuns = vi.fn(() => ({ runs: [run("lprun_older", 10)], total: 3 }));
    const slot = await mountPage({ get_screen: () => base, list_runs: listRuns });
    openTab(slot, "monitor", "history");
    const list = await slot.findByTestId("run-list");
    expect(list.children).toHaveLength(2);
    fireEvent.click(slot.getByTestId("runs-show-more"));
    await waitFor(() => expect(list.children).toHaveLength(3));
    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_ui", offset: 2, limit: 20 }));
    expect(slot.queryByTestId("runs-show-more")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows persisted stage receipts with translated stage labels", async () => {
    setLocaleOverride("en");
    const slot = await mountPage();
    openTab(slot, "monitor");
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
    fireEvent.click((await russian.findByTestId("stage-receipts-lprun_1")).querySelector("summary")!);
    await waitFor(() => expect(russian.getByTestId("stage-receipts-lprun_1").textContent).toContain(ru.stagePlanCritique));
    russian.lifecycle.unmount();
    setLocaleOverride(null);
  });

  it("hides cancel/retry when a run has no attempt", async () => {
    const base = screenFixture();
    const finish = vi.fn(() => ({ projectId:"proj_ui", finishedRunIds:["lprun_cli"], closed:true }));
    const slot = await mountPage({
      finish_run: finish,
      get_screen: () => ({
        ...base,
        runs: [{
          id: "lprun_cli",
          state: "accepted",
          kind: "cli",
          created_at: 1,
          updated_at: 1,
          cliReceiptJson: "{\"kind\":\"cli\",\"receiptPath\":\"/tmp/cli-receipt.json\"}",
          attempts: [],
        }],
        cliReceiptJson: "{\"kind\":\"cli\",\"receiptPath\":\"/tmp/cli-receipt.json\"}",
      }),
    });
    // The receipt lives in the Service segment, which mounts when it is opened.
    openTab(slot, "service");
    await slot.findByTestId("cli-receipt-lprun_cli");
    expect(slot.getByTestId("diagnostics-panel").textContent).toContain("cli-receipt.json");
    // The accepted CLI run is in the History.
    openTab(slot, "monitor", "history");
    expect(slot.getByTestId("run-lprun_cli")).toBeTruthy();
    const monitor = slot.getByTestId("run-monitor");
    expect(monitor.textContent).not.toContain(en.cancel);
    expect(monitor.textContent).not.toContain("cli-receipt.json");
    const finishButton = Array.from(monitor.querySelectorAll("button")).find((button) => button.textContent === en.finishRun);
    expect(finishButton).toBeTruthy();
    fireEvent.click(finishButton!);
    await waitFor(() => expect(finish).toHaveBeenCalledWith({ projectId:"proj_ui", runId:"lprun_cli" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.objectContaining({
      props: expect.objectContaining({ "data-bb-ru-skip": true, children: en.runClosed }),
    })));
    slot.lifecycle.unmount();
  });
});
