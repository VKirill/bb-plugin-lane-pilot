/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { VISIBLE_CATALOG, DISABLED_IDS, EDITABLE_IDS } from "../src/ui-catalog";
import { en, ru, setLocaleOverride, t } from "../i18n";
import { EXTERNAL_OPS } from "../src/constants";

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

async function mountPage(rpc: Record<string, (input: never) => unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, {
    context: { projectId: "proj_ui", threadId: null },
    rpc: {
      get_screen: () => screenFixture(),
      save_setting: () => ({ ok: true, conflict: false, version: 2, value: true }),
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

  it("applies saved ui.language even when document lang is en", async () => {
    document.documentElement.lang = "en";
    const base = screenFixture();
    const slot = await mountPage({
      get_screen: () => ({ ...base, values: { ...base.values, "ui.language": "ru" } }),
    });
    await slot.findByText(ru.tabSettings);
    fireEvent.click(slot.getAllByTestId("tab-monitor").at(-1)!);
    expect(slot.getAllByText(ru.state_running).length).toBeGreaterThan(0);
    expect(slot.getAllByText(new RegExp(ru.unappliedNoChannel)).length).toBeGreaterThan(0);
    slot.lifecycle.unmount();
  });

  it("does not leak ui.language into document.lang or another project", async () => {
    document.documentElement.lang = "en";
    const base = screenFixture();
    const first = await mountPage({
      get_screen: () => ({ ...base, values: { ...base.values, "ui.language": "ru" } }),
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
    const slot = await mountPage({
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
