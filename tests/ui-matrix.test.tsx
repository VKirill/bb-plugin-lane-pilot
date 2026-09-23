/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { VISIBLE_CATALOG, DISABLED_IDS, EDITABLE_IDS } from "../src/ui-catalog";
import { en, ru, setLocaleOverride, t, validationMessage } from "../i18n";
import { EXTERNAL_OPS } from "../src/constants";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

function screenFixture() {
  return {
    projectId: "proj_ui",
    hostId: "host_ui",
    workspacePath: "/tmp/lane-pilot-ui",
    values: Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, row.defaultValue])),
    versions: Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, 1])),
    importSource: { completed: true, at: 1, routingPath: "/tmp/routing.profile.yaml", nightPath: "/tmp/night-shift.yaml" },
    runs: [{
      id: "lprun_1",
      state: "running",
      kind: "bb",
      created_at: 1,
      updated_at: 1,
      cliReceiptJson: null,
      attempts: [{
        id: "lpattempt_1",
        state: "running",
        attempt_no: 1,
        thread_id: "thr_writer",
        reason: null,
        task_id: "task_1",
        cliReceiptJson: null,
      }],
    }],
    unapplied: [{ key: "plan_critique.mode", reason: "no proven runtime channel" }],
    lastSnapshotPath: "/tmp/snapshot",
    lastReceiptJson: "{\"action\":\"install\"}",
    writerResultJson: "{\"status\":\"accepted\",\"output\":\"hello from writer\"}",
    writerResultPatch: "--- /dev/null\n+++ b/writer-output.txt\n@@ -0,0 +1,1 @@\n+hello from writer\n",
    cliReceiptJson: null,
  };
}

async function mountPage(
  rpc: Record<string, (input: unknown) => unknown> = {},
  context: { projectId: string | null; threadId: string | null } = { projectId:"proj_ui", threadId:null },
  subPath = "",
) {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.navPanels[0]!, { subPath }, {
    context,
    rpc: {
      get_preferences: (input: unknown) => ({ locale: (input as {suggestedLocale:"en"|"ru"}).suggestedLocale, lastProjectId: null }),
      set_locale: (input: unknown) => ({ locale: (input as {locale:"en"|"ru"}).locale }),
      remember_project: () => ({ ok:true }),
      list_projects: () => ({ projects:[{ id:"proj_ui", name:"UI test" }], lastProjectId:"proj_ui" }),
      finish_run: () => ({ projectId:"proj_ui", finishedRunIds:[], closed:true }),
      get_screen: () => screenFixture(),
      save_setting: () => ({ ok: true, conflict: false, version: 2, value: true }),
      save_settings: () => ({ ok:true, conflict:false, values:{}, versions:{} }),
      cancel_attempt: () => ({ ok: true, state: "canceled", reason: null }),
      retry_attempt: () => ({ ok: true, state: "queued", attemptId: "lpattempt_2", reason: null }),
      resume_runs: () => ({ resumed: [], skipped: [], finished: [] }),
      stack_detect: () => ({ scenario: "S1" }),
      stack_install: () => ({ status: "ok" }),
      stack_connect: () => ({ status: "ok" }),
      stack_rollback: () => ({ status: "ok" }),
      ...rpc,
    },
  });
}

describe("Lane Pilot UI", () => {
  afterEach(() => {
    setLocaleOverride(null);
    document.documentElement.lang = "en";
  });

  it("opens the selected project from the no-context picker and remembers it", async () => {
    const remember = vi.fn(() => ({ ok:true }));
    const slot = await mountPage({
      list_projects: () => ({ projects:[{ id:"proj_ui", name:"UI test" }], lastProjectId:"proj_ui" }),
      remember_project: remember,
    }, { projectId:null, threadId:null });
    const select = await slot.findByLabelText(en.selectProject) as HTMLSelectElement;
    expect(select.value).toBe("proj_ui");
    fireEvent.click(slot.getByRole("button", { name:en.openProject }));
    await slot.findByText(en.importSource);
    expect(remember).toHaveBeenCalledWith({ projectId:"proj_ui" });
    slot.lifecycle.unmount();
  });

  it("renders every editable and read-only catalog field", async () => {
    const slot = await mountPage();
    for (const row of VISIBLE_CATALOG) {
      const node = slot.getByTestId(`field-${row.id}`);
      expect(node.getAttribute("data-ui-status")).toBe(row.uiStatus);
    }
    expect(EDITABLE_IDS.length + DISABLED_IDS.length).toBe(VISIBLE_CATALOG.length);
    for (const id of DISABLED_IDS) {
      const field = slot.getByTestId(`field-${id}`);
      expect(field.querySelector("[aria-disabled='true'], [disabled], [data-disabled], button[disabled], input[disabled]")).not.toBeNull();
      expect(field.textContent).toMatch(/Read only|Gap|Только чтение|Нет канала/);
    }
    slot.lifecycle.unmount();
  });

  it("switches all chrome strings when document lang is ru", async () => {
    document.documentElement.lang = "en";
    expect(t("tabSettings")).toBe(en.tabSettings);
    document.documentElement.lang = "ru";
    expect(t("tabSettings")).toBe(ru.tabSettings);
    expect(t("confirmBody")).toBe(ru.confirmBody);
    const slot = await mountPage();
    expect(slot.getByText(ru.tabSettings)).toBeTruthy();
    expect(slot.getByText(ru.tabMonitor)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows a CAS conflict instead of silently overwriting", async () => {
    const slot = await mountPage({
      save_setting: () => ({ ok: false, conflict: true, version: 3, value: "other" }),
    });
    await slot.findByText(en.importSource);
    const editable = VISIBLE_CATALOG.find((row) => row.uiStatus === "editable" && row.control === "switch");
    expect(editable).toBeTruthy();
    const field = slot.getByTestId(`field-${editable!.id}`);
    const sw = field.querySelector("[role='switch']") as HTMLButtonElement;
    fireEvent.click(sw);
    await slot.findByTestId("cas-conflict");
    slot.lifecycle.unmount();
  });

  it("shows validation separately from CAS and localizes the allowed values", async () => {
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
    await slot.findByText(ru.importSource);
    const editable = VISIBLE_CATALOG.find((row) => row.uiStatus === "editable" && row.control === "switch");
    const field = slot.getByTestId(`field-${editable!.id}`);
    fireEvent.click(field.querySelector("[role='switch']") as HTMLButtonElement);
    await slot.findByTestId("setting-validation-error");
    expect(slot.getByText(ru.validationInvalidChoice.replace("{key}", "writer.provider").replace("{allowed}", "agy, grok, qwen"))).toBeTruthy();
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("saves provider and effort rows atomically and advances UI values and versions from each server response", async () => {
    const calls: Array<{ changes:Array<{ key:string; value:unknown; expectedVersion:number }> }> = [];
    const values: Record<string, unknown> = { "writer.provider":"qwen", "writer.reasoning_effort":"medium" };
    const versions: Record<string, number> = { "writer.provider":5, "writer.reasoning_effort":8 };
    const slot = await mountPage({
      get_screen: () => ({ ...screenFixture(), values:{ ...screenFixture().values, ...values }, versions:{ ...screenFixture().versions, ...versions } }),
      save_settings: (input) => {
        const request = input as { changes:Array<{ key:string; value:unknown; expectedVersion:number }> };
        calls.push(request);
        for (const change of request.changes) {
          if ((versions[change.key] ?? 0) !== change.expectedVersion) {
            return { ok:false, conflict:true, values:{ ...values }, versions:{ ...versions } };
          }
        }
        const savedValues: Record<string, unknown> = {};
        const savedVersions: Record<string, number> = {};
        for (const change of request.changes) {
          values[change.key] = change.value;
          versions[change.key] = (versions[change.key] ?? 0) + 1;
          savedValues[change.key] = values[change.key];
          savedVersions[change.key] = versions[change.key]!;
        }
        return { ok:true, conflict:false, values:savedValues, versions:savedVersions };
      },
    });

    const provider = VISIBLE_CATALOG.find((row) => row.storageKey === "writer.provider" && row.uiStatus === "editable")!;
    const providerField = slot.getByTestId(`field-${provider.id}`);
    fireEvent.click(providerField.querySelector("[role='combobox']") as HTMLButtonElement);
    fireEvent.click(await slot.findByText("codex"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.changes.map((change) => [change.key, change.expectedVersion])).toEqual([
      ["writer.provider", 5], ["writer.reasoning_effort", 8],
    ]);
    expect(values).toMatchObject({ "writer.provider":"codex", "writer.reasoning_effort":"medium" });
    expect(versions).toMatchObject({ "writer.provider":6, "writer.reasoning_effort":9 });

    const effort = VISIBLE_CATALOG.find((row) => row.storageKey === "writer.reasoning_effort" && row.uiStatus === "editable")!;
    const effortField = slot.getByTestId(`field-${effort.id}`);
    fireEvent.click(effortField.querySelector("[role='combobox']") as HTMLButtonElement);
    fireEvent.click(await slot.findByText("max"));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.changes.map((change) => [change.key, change.expectedVersion])).toEqual([
      ["writer.reasoning_effort", 9], ["writer.provider", 6],
    ]);
    expect(values).toMatchObject({ "writer.provider":"codex", "writer.reasoning_effort":"max" });
    expect(versions).toMatchObject({ "writer.provider":7, "writer.reasoning_effort":10 });
    expect((effortField.querySelector("[role='combobox']") as HTMLButtonElement).textContent).toContain("max");
    slot.lifecycle.unmount();
  });

  it("adjusts an incompatible effort from the catalog provider row and announces the change", async () => {
    const changesSeen: Array<Array<{ key:string; value:unknown; expectedVersion:number }>> = [];
    const slot = await mountPage({
      get_screen: () => ({ ...screenFixture(), values:{ ...screenFixture().values, "writer.provider":"codex", "writer.reasoning_effort":"max" } }),
      save_settings: (input) => {
        const changes = (input as { changes:Array<{ key:string; value:unknown; expectedVersion:number }> }).changes;
        changesSeen.push(changes);
        return { ok:true, conflict:false, values:Object.fromEntries(changes.map(({key,value}) => [key,value])), versions:Object.fromEntries(changes.map(({key,expectedVersion}) => [key,expectedVersion + 1])) };
      },
    });
    const provider = VISIBLE_CATALOG.find((row) => row.storageKey === "writer.provider" && row.uiStatus === "editable")!;
    const field = slot.getByTestId(`field-${provider.id}`);
    fireEvent.click(field.querySelector("[role='combobox']") as HTMLButtonElement);
    fireEvent.click(await slot.findByText("qwen"));
    await waitFor(() => expect(changesSeen).toHaveLength(1));
    expect(changesSeen[0]!.map(({key,value}) => [key,value])).toEqual([
      ["writer.provider", "qwen"], ["writer.reasoning_effort", "low"],
    ]);
    expect(toast.info).toHaveBeenCalledWith(en.writerEffortAdjusted.replace("{from}", "max").replace("{to}", "low").replace("{provider}", "qwen"));
    slot.lifecycle.unmount();
  });

  it("asks for confirmation before external install operations", async () => {
    const slot = await mountPage();
    fireEvent.click(slot.getByTestId("tab-install"));
    fireEvent.click(await slot.findByTestId("install-stack"));
    const dialog = await slot.findByTestId("external-ops-dialog");
    expect(dialog.textContent).toContain("npm install -g @rama_nigg/open-cursor");
    expect(dialog.textContent).toContain(en.confirmBody);
    expect(dialog.className).toMatch(/overflow-x-hidden/);
    expect(dialog.className).toMatch(/max-w-\[359px\]/);
    expect(dialog.className).toMatch(/min-w-0/);
    expect(dialog.className).toMatch(/!max-w-\[359px\]/);
    slot.lifecycle.unmount();
  });

  it("lists connect-specific operations instead of install.sh commands", async () => {
    const slot = await mountPage();
    fireEvent.click(slot.getByTestId("tab-install"));
    fireEvent.click(slot.getByText(en.connectOpencode));
    const dialog = await slot.findByTestId("external-ops-dialog");
    expect(dialog.textContent).toContain(en.confirmConnectOps);
    expect(dialog.textContent).not.toContain("npm install -g @rama_nigg/open-cursor");
    slot.lifecycle.unmount();
  });

  it("shows writer result on the monitor and install receipt on the install tab", async () => {
    const slot = await mountPage();
    await slot.findByText(en.importSource);
    const writer = await slot.findByTestId("writer-result");
    expect(writer.textContent).toContain("hello from writer");
    const monitor = slot.getByTestId("run-monitor");
    expect(monitor.textContent).not.toContain("\"action\":\"install\"");
    fireEvent.click(slot.getByTestId("tab-install"));
    const install = await slot.findByTestId("install-receipt");
    expect(install.textContent).toContain("\"action\":\"install\"");
    expect(install.textContent).not.toContain("hello from writer");
    slot.lifecycle.unmount();
  });

  it("applies saved global locale even when document lang is en", async () => {
    document.documentElement.lang = "en";
    const base = screenFixture();
    const slot = await mountPage({
      get_preferences: () => ({ locale:"ru", lastProjectId:null }),
      get_screen: () => base,
    });
    await slot.findByText(ru.tabSettings);
    fireEvent.click(slot.getAllByTestId("tab-monitor").at(-1)!);
    expect(slot.getAllByText(ru.state_running).length).toBeGreaterThan(0);
    expect(slot.getAllByText(new RegExp(ru.unappliedNoChannel)).length).toBeGreaterThan(0);
    slot.lifecycle.unmount();
  });

  it("does not leak the locale into document.lang", async () => {
    document.documentElement.lang = "en";
    const base = screenFixture();
    const first = await mountPage({
      get_preferences: () => ({ locale:"ru", lastProjectId:null }),
    });
    await first.findByText(ru.tabSettings);
    expect(document.documentElement.lang).toBe("en");
    first.lifecycle.unmount();
    setLocaleOverride(null);
    const second = await mountPage({
      get_screen: () => ({ ...base, projectId: "proj_other", values: { ...base.values } }),
    });
    await second.findByText(en.tabSettings);
    expect(second.queryByText(ru.tabSettings)).toBeNull();
    second.lifecycle.unmount();
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
    await slot.findByTestId("cli-receipt-lprun_cli");
    expect(slot.getByTestId("run-lprun_cli")).toBeTruthy();
    const monitor = slot.getByTestId("run-monitor");
    expect(monitor.textContent).not.toContain(en.cancel);
    expect(monitor.textContent).toContain("cli-receipt.json");
    const finishButton = Array.from(monitor.querySelectorAll("button")).find((button) => button.textContent === en.finishRun);
    expect(finishButton).toBeTruthy();
    fireEvent.click(finishButton!);
    await waitFor(() => expect(finish).toHaveBeenCalledWith({ projectId:"proj_ui", runId:"lprun_cli" }));
    slot.lifecycle.unmount();
  });

  it("opens a distinct CLI receipt for each run", async () => {
    const base = screenFixture();
    const slot = await mountPage({
      get_screen: () => ({
        ...base,
        runs: [
          {
            id: "lprun_a",
            state: "accepted",
            kind: "cli",
            created_at: 1,
            updated_at: 2,
            cliReceiptJson: "{\"lanePilotRunId\":\"lprun_a\",\"mark\":\"first\"}",
            attempts: [{
              id: "lpattempt_a",
              state: "accepted",
              attempt_no: 1,
              thread_id: null,
              reason: null,
              task_id: "task_a",
              cliReceiptJson: "{\"lanePilotRunId\":\"lprun_a\",\"mark\":\"first\"}",
            }],
          },
          {
            id: "lprun_b",
            state: "accepted",
            kind: "cli",
            created_at: 2,
            updated_at: 3,
            cliReceiptJson: "{\"lanePilotRunId\":\"lprun_b\",\"mark\":\"second\"}",
            attempts: [{
              id: "lpattempt_b",
              state: "accepted",
              attempt_no: 1,
              thread_id: null,
              reason: null,
              task_id: "task_b",
              cliReceiptJson: "{\"lanePilotRunId\":\"lprun_b\",\"mark\":\"second\"}",
            }],
          },
        ],
      }),
    });
    await slot.findByTestId("cli-receipt-lpattempt_a");
    fireEvent.click(slot.getByTestId("tab-monitor"));
    expect(slot.getByTestId("cli-receipt-lpattempt_a").textContent).toContain("first");
    expect(slot.getByTestId("cli-receipt-lpattempt_b").textContent).toContain("second");
    slot.lifecycle.unmount();
  });

  it("shows the off-value limitation on writer.fast_mode fields", async () => {
    const slot = await mountPage();
    const limitation = await slot.findByTestId("channel-limitation-s024");
    expect(limitation.textContent).toBe(en.channelOffLimitation);
    slot.lifecycle.unmount();
  });

  it("keeps the confirm dialog title and full install ops list in the DOM", async () => {
    const slot = await mountPage();
    await slot.findByTestId("install-stack");
    fireEvent.click(slot.getByTestId("tab-install"));
    fireEvent.click(slot.getByTestId("install-stack"));
    const dialog = await slot.findByTestId("external-ops-dialog");
    expect(dialog.textContent).toContain(en.confirmTitle);
    for (const op of EXTERNAL_OPS) {
      expect(dialog.textContent).toContain(op);
    }
    slot.lifecycle.unmount();
  });
});
