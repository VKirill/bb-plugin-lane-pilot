/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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
    explicitKeys: ["writer.provider", "writer.model", "writer.reasoning_effort"],
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
      stages: [{
        contractVersion:1, runId:"lprun_1", taskId:"task_1", stageId:"plan-critique", state:"passed",
        inputSha256:"a".repeat(64), outputSha256:"b".repeat(64), attempt:1,
        providerId:"codex", model:"test-model", threadId:"thr_critic",
        result:{ decision:"approve", summary:"Plan checked", findings:[] }, reason:null, updatedAt:1,
      }],
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
    qaHosts: [
      { id:"host_ui", name:"Writer", status:"connected", connected:true },
      { id:"host-qa-mini", name:"Mini", status:"connected", connected:true },
    ],
    lastWriterTrace: null,
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
      get_globals: () => ({ defaults: {}, revision: 0, agents: [] }),
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
    expect(slot.getByTestId("scope-rail")).toBeTruthy();
    expect(slot.getByTestId("scope-nav").querySelector(".grid")).toBeNull();
    expect(slot.getByTestId("tab-settings").closest("[data-testid='project-settings']")).toBeTruthy();
    expect(slot.getByTestId("main-agent").textContent).toContain(en.mainAgent);
    expect(slot.getByTestId("main-agent").textContent).not.toMatch(/spawn|compiled/i);
    slot.lifecycle.unmount();
  }, 10_000);

  it("keeps technical fields in Diagnostics and renders each storage key once", async () => {
    const slot = await mountPage();
    expect(slot.queryByTestId("field-s004")).toBeNull();
    expect(slot.getByTestId("settings-panel").textContent).not.toContain("CAS version");
    expect(slot.getByTestId("settings-panel").textContent).not.toContain("--writer-provider");
    expect(slot.getByTestId("settings-panel").querySelector("[data-storage-key='adoc.177']")).toBeNull();
    expect(slot.getByTestId("settings-panel").querySelector("[data-storage-key='adoc.166']")).toBeNull();
    expect(slot.getByTestId("pm-read-settings")).toBeTruthy();
    fireEvent.click(slot.getByTestId("tab-checks"));
    expect(slot.getByTestId("plan-critique-settings")).toBeTruthy();
    expect(slot.getByTestId("plan-critique-settings").textContent).not.toContain("plan_critique.agent");
    expect(slot.getByTestId("plan-critique-settings").textContent).not.toMatch(/dispatch|changes_requested/);
    expect(slot.getByTestId("code-critique-settings")).toBeTruthy();
    fireEvent.click(slot.getByTestId("tab-settings"));
    expect(slot.getByTestId("settings-panel").textContent).not.toContain(`${en.fieldDefault}:`);
    expect(slot.getByTestId("settings-panel").textContent).not.toContain(`${en.fieldEffective}:`);
    fireEvent.click(slot.getByTestId("help-pm_read.min_lines"));
    expect(slot.getByTestId("help-dialog-pm_read.min_lines").textContent).toContain(en.largeFileThresholdHelp);
    fireEvent.click(slot.getByTestId("tab-diagnostics"));
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

  it("does not emit React duplicate-key warnings for medium or night_review.model", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args); });
    const slot = await mountPage();
    expect(slot.getByTestId("night-review-settings").querySelector("[data-testid='bb-provider-model-picker']")).toBeTruthy();
    fireEvent.click(slot.getByTestId("tab-diagnostics"));
    const joined = errors.map((item) => String(item)).join("\n");
    expect(joined).not.toMatch(/same key/i);
    expect(joined).not.toContain("night_review.model");
    expect(joined).not.toMatch(/key=["']medium["']/i);
    spy.mockRestore();
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
    expect(slot.getByText(ru.tabChecks)).toBeTruthy();
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
    expect(settings.querySelector("[data-testid='writer-effort-mode']")).not.toBeNull();
    expect(settings.querySelector("[data-testid='browser-qa-host']")).not.toBeNull();
    expect(settings.querySelector("[data-testid='field-s004']")).toBeNull();
    expect(settings.querySelector("[data-testid='field-s022']")).toBeNull();
    expect(settings.querySelector("[data-testid='field-s023']")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows localized enum labels and stores the original codes", async () => {
    const saved: Array<{ key:string; value:unknown }> = [];
    const slot = await mountPage({
      save_setting: (input: unknown) => {
        const row = input as { key:string; value:unknown };
        saved.push(row);
        return { ok:true, conflict:false, version:2, value:row.value };
      },
    });
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const field = slot.getByTestId("field-s040");
    expect(field.textContent).toContain(en.enumWorkspaceAuto);
    expect(field.textContent).not.toContain("in_place");
    fireEvent.click(slot.getByTestId("help-adoc.040"));
    expect(slot.getByTestId("help-dialog-adoc.040").textContent).toContain(en.workspaceModeHelp);
    expect(slot.getByTestId("help-dialog-adoc.040").textContent).not.toContain("in_place");
    fireEvent.click(field.querySelector("button[role='combobox']") as HTMLButtonElement);
    fireEvent.click(slot.getByRole("option", { name: en.enumWorkspaceInPlace }));
    await waitFor(() => expect(saved).toContainEqual(expect.objectContaining({ key:"adoc.040", value:"in_place" })));
    expect(slot.getByTestId("browser-qa-host-select")).toBeTruthy();
    expect(slot.getByTestId("browser-qa-host").textContent).not.toContain(en.browserQaHostNone);
    slot.lifecycle.unmount();
    Object.defineProperty(navigator, "language", { configurable: true, value: "ru-RU" });
    document.documentElement.lang = "ru";
    const ruSlot = await mountPage();
    await waitFor(() => expect(ruSlot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    expect(ruSlot.getByTestId("field-s040").textContent).toContain(ru.enumWorkspaceAuto);
    expect(ruSlot.getByTestId("field-s040").textContent).not.toContain("in_place");
    ruSlot.lifecycle.unmount();
    document.documentElement.lang = "en";
    setLocaleOverride(null);
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

  it("renders host coexistence inventory with owner, capability, and evidence", async () => {
    const slot = await mountPage({
      stack_detect: () => ({
        hostId:"host_ui", laneStack:{ present:true, version:"custom", sourceSha:"other" },
        openCode:{ present:true, version:"1.18.30" }, workspace:{ path:"/tmp/work", present:true },
        targetSha:"dd77", matchesTarget:false, scenario:"S2",
        coexistence:{ managers:[{
          manager:"managed-checkout", path:"/opt/engine", installed:true, configured:true, loaded:null,
          compatible:true, modified:true, version:"custom", sourceSha:"abc", sha256:"a".repeat(64),
          owner:"user", decision:"reuse", missingCapabilities:[],
          evidence:[{ kind:"capability", path:"/opt/engine", sha256:"a".repeat(64), detail:"required interface listAgentRuns available" }],
        }] },
      }),
    });
    fireEvent.click(slot.getByTestId("tab-install"));
    fireEvent.click(slot.getByTestId("stack-detect"));
    const inventory = await slot.findByTestId("coexistence-inventory");
    const checkout = slot.getByTestId("coex-managed-checkout");
    expect(inventory.textContent).toContain(en.coexInventory);
    expect(checkout.textContent).toContain(en.coexDecisionReuse);
    expect(checkout.textContent).toContain(en.coexOwnerUser);
    expect(checkout.textContent).toContain(en.coexRuntimeUnverified);
    expect(checkout.textContent).toContain(en.coexCompatible);
    expect(checkout.textContent).toContain("required interface listAgentRuns available");
    expect(slot.getByTestId("stack-detect-result").textContent).toContain(en.targetMatchInformational);
    slot.lifecycle.unmount();
  }, 15000);

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

  it("shows persisted stage receipts with translated stage labels", async () => {
    setLocaleOverride("en");
    const slot = await mountPage();
    fireEvent.click(slot.getByTestId("tab-monitor"));
    const card = await slot.findByTestId("stage-receipts-lprun_1");
    expect(card.textContent).toContain(en.stagePlanCritique);
    expect(card.textContent).toContain(en.state_passed);
    expect(card.textContent).toContain("Plan checked");

    slot.lifecycle.unmount();
    const russian = await mountPage({ get_preferences: () => ({ locale:"ru", preference:"ru", lastProjectId:"proj_ui" }) });
    await russian.findByTestId("tab-monitor");
    await russian.findByTestId("tab-monitor");
    fireEvent.click(russian.getByTestId("tab-monitor"));
    expect(russian.getByTestId("stage-receipts-lprun_1").textContent).toContain(ru.stagePlanCritique);
    russian.lifecycle.unmount();
    setLocaleOverride(null);
  });

  it("shows only legal cancel and retry actions in both monitor layouts", async () => {
    for (const scenario of [
      { runState:"closed", attemptState:"accepted", cancel:false, retry:false },
      { runState:"closed", attemptState:"validation_failed", cancel:false, retry:false },
      { runState:"running", attemptState:"queued", cancel:true, retry:false },
      { runState:"running", attemptState:"running", cancel:true, retry:false },
      { runState:"running", attemptState:"validation_failed", cancel:false, retry:true },
    ]) {
      const base = screenFixture();
      const run = base.runs[0]!;
      run.state = scenario.runState;
      run.attempts[0]!.state = scenario.attemptState;
      (run.attempts[0]! as {thread_id:string|null}).thread_id = scenario.attemptState === "queued" ? null : "thr_writer";
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

  it("renders numeric limits instead of sliders and keeps a failed draft", async () => {
    const slot = await mountPage({
      save_setting: () => ({ ok: false, conflict: false, version: 1, value: 5, validation: {
        code: "invalid_choice", key: "night_review.max_fix_tasks", params: ["night_review.max_fix_tasks", "1-10"],
      } }),
    });
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const field = await slot.findByTestId("settings-panel").then((panel) => panel.querySelector("[data-testid='field-s006']") as HTMLElement);
    expect(field).toBeTruthy();
    expect(field.querySelector("[role='slider']")).toBeNull();
    const input = field.querySelector("input[type='number']") as HTMLInputElement;
    expect(input.min).toBe("1");
    expect(input.max).toBe("10");
    expect(field.textContent).toContain(en.fieldLimits);
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.blur(input);
    await slot.findByTestId("setting-validation-error");
    expect((field.querySelector("input[type='number']") as HTMLInputElement).value).toBe("8");
    slot.lifecycle.unmount();
  });

  it("keeps the latest numeric value across deferred saves from 1 to 10", async () => {
    const deferred: Array<{
      value: unknown;
      expectedVersion: number;
      resolve: (result: { ok: boolean; conflict: boolean; version: number; value: unknown }) => void;
    }> = [];
    const slot = await mountPage({
      save_setting: (input: unknown) => {
        const { value, expectedVersion } = input as { value: unknown; expectedVersion: number };
        return new Promise((resolve) => {
          deferred.push({ value, expectedVersion, resolve });
        });
      },
    });
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const input = slot.getByTestId("settings-panel").querySelector("[data-testid='field-s006'] input[type='number']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    await waitFor(() => expect(deferred.length).toBe(1));
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    expect(input.value).toBe("10");
    deferred[0]!.resolve({ ok: true, conflict: false, version: 2, value: deferred[0]!.value });
    await waitFor(() => expect(deferred.some((item) => item.value === 10)).toBe(true));
    expect(input.value).toBe("10");
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    for (const item of deferred) item.resolve({ ok: true, conflict: false, version: item.expectedVersion + 1, value: item.value });
    await waitFor(() => expect(input.value).toBe("10"));
    expect(deferred.at(-1)?.value).toBe(10);
    slot.lifecycle.unmount();
  });

  it("keeps the unsaved numeric draft on an external CAS conflict", async () => {
    const slot = await mountPage({
      save_setting: () => ({ ok: false, conflict: true, version: 9, value: 3 }),
    });
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const input = slot.getByTestId("settings-panel").querySelector("[data-testid='field-s006'] input[type='number']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    await slot.findByTestId("cas-conflict");
    expect(input.value).toBe("10");
    slot.lifecycle.unmount();
  });

  it("filters settings by search and keeps picker keys off the settings list", async () => {
    const slot = await mountPage();
    expect(slot.getByTestId("settings-panel").querySelector("[data-testid='field-s004']")).toBeNull();
    expect(slot.getByTestId("settings-group-browser-qa")).toBeTruthy();
    fireEvent.change(slot.getByTestId("settings-search"), { target: { value: "zzzz-no-match" } });
    expect(slot.queryByTestId("writer-picker")).toBeNull();
    expect(slot.getByText(en.noMatchingSettings)).toBeTruthy();
    fireEvent.change(slot.getByTestId("settings-search"), { target: { value: "" } });
    fireEvent.click(slot.getByRole("button", { name: en.settingsAdvanced }));
    expect(slot.getByTestId("settings-group-workspace")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("switches the new settings chrome in Russian", async () => {
    Object.defineProperty(navigator, "language", { configurable: true, value: "ru-RU" });
    setLocaleOverride(null);
    document.documentElement.lang = "ru";
    const slot = await mountPage({
      get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }),
    });
    expect(slot.getByText(ru.settingsSearch)).toBeTruthy();
    expect(slot.getByTestId("settings-depth").textContent).toContain(ru.settingsBasic);
    expect(slot.getByTestId("settings-depth").textContent).toContain(ru.settingsAdvanced);
    slot.lifecycle.unmount();
  });

  it("refreshes active and cached project inheritance after saving global defaults without dropping drafts", async () => {
    let revision = 0;
    let defaults: Record<string, unknown> = { helperPlacement: "plugin" };
    const screen = () => {
      const payload = screenFixture();
      return { ...payload, values: { ...payload.values, "helper.placement": "plugin" }, versions: { ...payload.versions, "helper.placement": 0 }, inheritedKeys: ["helper.placement"] };
    };
    const slot = await mountPage({
      get_screen: screen,
      get_globals: () => ({ defaults, revision, agents: [] }),
      save_globals: ({ defaults: next, expectedRevision }: any) => {
        if (expectedRevision !== revision) return { ok: false, revision, defaults };
        defaults = next; revision += 1;
        return { ok: true, revision, defaults };
      },
    });
    await slot.findByTestId("settings-panel");
    fireEvent.click(slot.getAllByRole("tab", { name: "General settings" })[0]!);
    const placement = await slot.findByRole("combobox", { name: "Default helper placement" });
    fireEvent.click(placement);
    fireEvent.click(await slot.findByRole("option", { name: "In the project tree" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await slot.findByRole("status");
    fireEvent.click(slot.getByTestId("project-item-proj_ui"));
    await waitFor(() => expect(slot.getByTestId("project-settings").hidden).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: en.settingsAdvanced }));
    const row = slot.getByTestId("field-s371");
    expect(row.textContent).toContain("In the project tree");
    expect(row.textContent).toContain("owner defaults");
    // Reselecting this project takes the reconciled cache, never the pre-save value.
    fireEvent.click(slot.getAllByRole("tab", { name: "General settings" })[0]!);
    fireEvent.click(slot.getByTestId("project-item-proj_ui"));
    await waitFor(() => expect(slot.getByTestId("project-settings").hidden).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: en.settingsAdvanced }));
    expect(slot.getByTestId("field-s371").textContent).toContain("In the project tree");
    slot.lifecycle.unmount();
  });

  it("shows owner inheritance after reset even while the durable CAS generation stays positive", async () => {
    let reset = false;
    const getScreen = () => {
      const payload = screenFixture();
      return {
        ...payload,
        values: { ...payload.values, "helper.placement": "project_tree" },
        versions: { ...payload.versions, "helper.placement": reset ? 2 : 1 },
        explicitKeys: reset ? [] : ["writer.provider", "writer.model", "writer.reasoning_effort", "helper.placement"],
        inheritedKeys: reset ? ["helper.placement"] : [],
      };
    };
    const slot = await mountPage({
      get_screen: getScreen,
      reset_project_settings: () => { reset = true; return { ok: true, conflict: false, values: { "helper.placement": null }, versions: { "helper.placement": 2 } }; },
    });
    fireEvent.click(slot.getByRole("button", { name: en.settingsAdvanced }));
    const row = slot.getByTestId("field-s371");
    await waitFor(() => expect(row.textContent).toContain("Set on this project"));
    fireEvent.click(within(row).getByRole("button", { name: "Reset to inherited" }));
    await waitFor(() => expect(row.textContent).toContain("owner defaults"));
    expect(row.textContent).not.toContain("Set on this project");
    expect(within(row).queryByRole("button", { name: "Reset to inherited" })).toBeNull();
    expect(slot.getByTestId("field-s371").textContent).toContain("project tree");
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
