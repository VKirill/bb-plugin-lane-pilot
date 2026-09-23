/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { VISIBLE_CATALOG, DISABLED_IDS, EDITABLE_IDS } from "../src/ui-catalog";
import { en, ru, setLocaleOverride, t, validationMessage } from "../i18n";
import { EXTERNAL_OPS } from "../src/constants";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

function screenFixture() {
  const values = Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, row.defaultValue]));
  values["writer.provider"] = "codex";
  values["writer.model"] = "test-model";
  values["writer.reasoning_effort"] = "medium";
  return {
    projectId: "proj_ui",
    hostId: "host_ui",
    workspacePath: "/tmp/lane-pilot-ui",
    values,
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
    cliPreview: { argv:["run", "--provider", "codex", "--service-tier", "fast"], env:{}, applied:["writer.provider"], unapplied:[] },
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
    providers:{ status:"ready", providers:[{
      id:"codex", displayName:"Codex", available:true,
      capabilities:{ modelCatalogScope:"host", permissionModes:[], supportsFork:false, supportsNativeUserQuestion:false,
        supportsServiceTier:true, supportsSessionRewind:false, supportsThreadArchive:false, supportsThreadRename:false },
      serviceTiers:[{ id:"default", label:"Default" }, { id:"fast", label:"Fast" }],
    }] as never },
    rpc: {
      get_preferences: (input: unknown) => ({ locale: (input as {suggestedLocale:"en"|"ru"}).suggestedLocale, preference:"auto", lastProjectId: null }),
      set_locale: (input: unknown) => ({ locale: (input as {locale:"auto"|"en"|"ru"; suggestedLocale:"en"|"ru"}).locale === "auto" ? (input as {suggestedLocale:"en"|"ru"}).suggestedLocale : (input as {locale:"en"|"ru"}).locale, preference: (input as {locale:"auto"|"en"|"ru"}).locale }),
      remember_project: () => ({ ok:true }),
      list_projects: () => ({ projects:[{ id:"proj_ui", name:"UI test" }], lastProjectId:"proj_ui" }),
      finish_run: () => ({ projectId:"proj_ui", finishedRunIds:[], closed:true }),
      get_screen: () => screenFixture(),
      save_setting: () => ({ ok: true, conflict: false, version: 2, value: true }),
      save_settings: () => ({ ok:true, conflict:false, values:{}, versions:{} }),
      cancel_attempt: () => ({ ok: true, state: "canceled", reason: null }),
      retry_attempt: () => ({ ok: true, state: "queued", attemptId: "lpattempt_2", reason: null }),
      resume_runs: () => ({ resumed: [], skipped: [], finished: [] }),
      stack_detect: () => ({
        hostId:"host_ui", laneStack:{ present:true, version:"1.38.0", sourceSha:"abc123" },
        openCode:{ present:true, version:"1.18.30" }, workspace:{ path:"/tmp/lane-pilot-ui", present:true },
        targetSha:"abc123", matchesTarget:true, scenario:"S1",
      }),
      stack_install: () => ({ status: "ok" }),
      stack_connect: () => ({ status: "ok" }),
      stack_rollback: () => ({ status: "ok" }),
      ...rpc,
    },
  });
}

describe("Lane Pilot UI", () => {
  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    Object.defineProperty(navigator, "language", { configurable: true, value: "en-US" });
  });

  it("shows the selected project's settings immediately and remembers the rail selection", async () => {
    const remember = vi.fn(() => ({ ok:true }));
    const slot = await mountPage({
      list_projects: () => ({ projects:[{ id:"proj_ui", name:"UI test" }], lastProjectId:"proj_ui" }),
      remember_project: remember,
    }, { projectId:null, threadId:null });
    const project = await slot.findByTestId("project-item-proj_ui");
    fireEvent.click(project);
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    expect(remember).toHaveBeenCalledWith({ projectId:"proj_ui" });
    expect(slot.queryByRole("button", { name:en.openProject })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps technical fields in Diagnostics and renders each storage key once", async () => {
    const slot = await mountPage();
    expect(slot.queryByTestId("field-s004")).toBeNull();
    expect(slot.getByTestId("settings-panel").textContent).not.toContain("CAS version");
    expect(slot.getByTestId("settings-panel").textContent).not.toContain("--writer-provider");
    fireEvent.click(slot.getByTestId("tab-diagnostics"));
    const fields = Array.from(slot.container.querySelectorAll<HTMLElement>("[data-storage-key]"));
    const keys = fields.map((node) => node.getAttribute("data-storage-key"));
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("writer.fast_mode");
    expect(slot.getByTestId("field-s024").textContent).toContain(en.legacyFastModeExplanation);
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
    expect(slot.getByText(ru.tabSettings)).toBeTruthy();
    expect(slot.getByText(ru.tabMonitor)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows a CAS conflict instead of silently overwriting", async () => {
    const slot = await mountPage({
      save_setting: () => ({ ok: false, conflict: true, version: 3, value: "other" }),
    });
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const sw = slot.container.querySelector("[data-testid='settings-panel'] [data-testid='jev-settings'] [role='switch']") as HTMLButtonElement;
    fireEvent.click(sw);
    await slot.findByTestId("cas-conflict");
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
    fireEvent.click(slot.container.querySelector("[data-testid='settings-panel'] [data-testid='jev-settings'] [role='switch']") as HTMLButtonElement);
    await slot.findByTestId("setting-validation-error");
    expect(slot.getByText(ru.validationInvalidChoice.replace("{key}", "writer.provider").replace("{allowed}", "agy, grok, qwen"))).toBeTruthy();
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps the writer selection in one native catalog picker", async () => {
    const slot = await mountPage();
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const settings = slot.container.querySelector("[data-testid='settings-panel']")!;
    expect(settings?.querySelector("[data-testid='writer-picker'] [data-testid='bb-provider-model-picker']")).not.toBeNull();
    expect(settings.querySelector("[data-testid='field-s004']")).toBeNull();
    expect(settings.querySelector("[data-testid='field-s022']")).toBeNull();
    expect(settings.querySelector("[data-testid='field-s023']")).toBeNull();
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

  it("shows writer output and installation receipts only in Diagnostics", async () => {
    const slot = await mountPage();
    fireEvent.click(slot.getByTestId("tab-monitor"));
    expect(slot.queryByTestId("writer-result")).toBeNull();
    fireEvent.click(slot.getByTestId("tab-diagnostics"));
    const preview = await slot.findByTestId("cli-preview");
    const previewJson = JSON.parse(preview.querySelector("code")!.textContent!) as { argv:string[] };
    expect(previewJson.argv.filter((arg) => arg === "--provider")).toHaveLength(1);
    expect(previewJson.argv).toContain("fast");
    const writer = await slot.findByTestId("writer-result");
    expect(writer.textContent).toContain("hello from writer");
    expect(slot.getByTestId("diagnostics-panel").textContent).toContain("\"action\":\"install\"");
    fireEvent.click(slot.getByTestId("tab-install"));
    expect(slot.container.querySelector("[data-testid='diagnostics-panel']")?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(slot.getByTestId("tab-diagnostics"));
    const install = await slot.findByTestId("install-receipt");
    expect(install.textContent).toContain("\"action\":\"install\"");
    expect(install.textContent).not.toContain("hello from writer");
    slot.lifecycle.unmount();
  });

  it("shows stack detection details in English and Russian", async () => {
    for (const locale of ["en", "ru"] as const) {
      const slot = await mountPage({
        get_preferences: () => ({ locale, preference:locale, lastProjectId:null }),
      });
      fireEvent.mouseDown(slot.getByTestId("tab-install"), { button:0 });
      fireEvent.click(slot.getByTestId("tab-install"));
      await waitFor(() => expect(slot.getByTestId("install-panel").hidden).toBe(false));
      fireEvent.click(slot.getByText(locale === "ru" ? ru.detect : en.detect));
      const result = await slot.findByTestId("stack-detect-result");
      expect(result.textContent).toContain(locale === "ru" ? ru.detectScenario : en.detectScenario);
      expect(result.textContent).toContain("S1");
      expect(result.textContent).toContain("1.38.0");
      expect(result.textContent).toContain("1.18.30");
      expect(result.textContent).not.toContain("/tmp/lane-pilot-ui");
      expect(result.textContent).not.toContain("/tmp/snapshot");
      fireEvent.click(slot.getByTestId("tab-diagnostics"));
      expect(slot.getByTestId("import-diagnostics").textContent).toContain("/tmp/lane-pilot-ui");
      expect(slot.getByTestId("import-diagnostics").textContent).toContain("/tmp/snapshot");
      slot.lifecycle.unmount();
    }
  });

  it("uses a mobile card monitor and hides the wide table below the sm breakpoint", async () => {
    const slot = await mountPage();
    fireEvent.mouseDown(slot.getByTestId("tab-monitor"), { button:0 });
    fireEvent.click(slot.getByTestId("tab-monitor"));
    await waitFor(() => expect(slot.getByTestId("run-monitor").hidden).toBe(false));
    const mobile = await slot.findByTestId("run-monitor-mobile");
    expect(mobile.querySelector('[data-testid="mobile-attempt-lpattempt_1"]')).not.toBeNull();
    const monitor = slot.getByTestId("run-monitor");
    const wideWrapper = Array.from(monitor.querySelectorAll("div")).find((element) => element.classList.contains("hidden") && element.classList.contains("sm:block"));
    const wideTable = wideWrapper?.querySelector("table");
    expect(wideTable).not.toBeNull();
    expect(mobile.className).toContain("sm:hidden");
    slot.lifecycle.unmount();
  });

  it("shows only legal cancel and retry actions in both monitor layouts", async () => {
    for (const scenario of [
      { runState:"closed", attemptState:"accepted", cancel:false, retry:false },
      { runState:"closed", attemptState:"validation_failed", cancel:false, retry:false },
      { runState:"running", attemptState:"running", cancel:true, retry:false },
      { runState:"running", attemptState:"validation_failed", cancel:false, retry:true },
    ]) {
      const base = screenFixture();
      const run = base.runs[0]!;
      run.state = scenario.runState;
      run.attempts[0]!.state = scenario.attemptState;
      const slot = await mountPage({ get_screen:() => base });
      fireEvent.click(slot.getByTestId("tab-monitor"));
      const mobile = await slot.findByTestId("mobile-attempt-lpattempt_1");
      const desktop = slot.getByTestId("attempt-lpattempt_1");
      for (const row of [mobile, desktop]) {
        const buttons = Array.from(row.querySelectorAll("button")).map((button) => button.textContent);
        expect(buttons.includes(en.cancel)).toBe(scenario.cancel);
        expect(buttons.includes(en.retry)).toBe(scenario.retry);
      }
      slot.lifecycle.unmount();
    }
  });

  it("applies saved global locale even when document lang is en", async () => {
    document.documentElement.lang = "en";
    const base = screenFixture();
    const slot = await mountPage({
      get_preferences: () => ({ locale:"ru", preference:"ru", lastProjectId:null }),
      get_screen: () => base,
    });
    await slot.findByText(ru.tabSettings);
    fireEvent.click(slot.getAllByTestId("tab-monitor").at(-1)!);
    expect(slot.getAllByText(ru.state_running).length).toBeGreaterThan(0);
    fireEvent.click(slot.getByTestId("tab-diagnostics"));
    expect(slot.getAllByText(new RegExp(ru.unappliedNoChannel)).length).toBeGreaterThan(0);
    slot.lifecycle.unmount();
  });

  it("does not leak the locale into document.lang", async () => {
    document.documentElement.lang = "en";
    const base = screenFixture();
    const first = await mountPage({
      get_preferences: () => ({ locale:"ru", preference:"ru", lastProjectId:null }),
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
    fireEvent.click(slot.getByTestId("tab-diagnostics"));
    expect(slot.getByTestId("diagnostics-panel").textContent).toContain("cli-receipt.json");
    fireEvent.click(slot.getByTestId("tab-monitor"));
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

  it("opens each CLI receipt only in Diagnostics", async () => {
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
    fireEvent.click(slot.getByTestId("tab-monitor"));
    expect(slot.queryByTestId("cli-receipt-lpattempt_a")).toBeNull();
    fireEvent.click(slot.getByTestId("tab-diagnostics"));
    expect((await slot.findByTestId("cli-receipt-lpattempt_a")).textContent).toContain("first");
    expect((await slot.findByTestId("cli-receipt-lpattempt_b")).textContent).toContain("second");
    slot.lifecycle.unmount();
  });

  it("shows the legacy fast-mode mapping in Diagnostics instead of a separate switch", async () => {
    const slot = await mountPage();
    fireEvent.click(slot.getByTestId("tab-diagnostics"));
    const migration = await slot.findByTestId("field-s024");
    expect(migration.textContent).toContain(en.legacyFastModeExplanation);
    expect(migration.querySelector("[role='switch']")).toBeNull();
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
