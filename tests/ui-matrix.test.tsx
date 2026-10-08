/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAllTabs, openTab } from "./ui-tabs";
import { cleanup, configure, fireEvent, waitFor, within } from "@testing-library/react";
import { mountPage, missingStack, screenFixture } from "./ui-harness";
import { VISIBLE_CATALOG, DISABLED_IDS, EDITABLE_IDS } from "@lane-pilot/settings-catalog";
import { en, ru, setLocaleOverride, t, validationMessage } from "@lane-pilot/i18n";
import { EXTERNAL_OPS } from "../src/constants";
import { toast } from "sonner";

// Heavy UI file: under a loaded machine single tests passed 20 s (2026-10-07), like agent-access-ui.
vi.setConfig({ testTimeout: 60_000 });

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

// Under load React updates and debounced saves settle after the 1 s default; await the real condition instead.
configure({ asyncUtilTimeout: 10_000 });

// Each test mounts the whole settings page (about 0.8 s of jsdom rendering alone, 1-5 s with its waits; the first import of
// the app is 1.3 s). The per-test budget is the file's 60 s above: a describe-level `timeout: 20_000` used to override it,
// and under a parallel run (load 18-20) a different one of the 36 tests crossed 20 s each time. A test that times out keeps
// running and mounts its page into the next test's DOM, so the DOM is emptied before each test as well as after.
/** Opens the Team tab and the drawer of one role row; returns the drawer. */
function openRole(slot: { getByTestId: (id: string) => HTMLElement }, role: string) {
  openTab(slot, "team");
  const opener = slot.getByTestId(`role-open-${role}`);
  if (opener.getAttribute("aria-expanded") !== "true") fireEvent.click(opener);
  return slot.getByTestId(`role-drawer-${role}`);
}

describe("Lane Pilot UI", () => {
  beforeEach(() => { cleanup(); document.body.innerHTML = ""; });
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
    await openAllTabs(slot);
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    expect(remember).toHaveBeenCalledWith({ projectId:"proj_ui" });
    expect(slot.queryByRole("button", { name:en.openProject })).toBeNull();
    expect(slot.getByTestId("scope-rail")).toBeTruthy();
    expect(slot.getByTestId("scope-nav").querySelector(".grid")).toBeNull();
    expect(slot.getByTestId("tab-work").closest("[data-testid='project-settings']")).toBeTruthy();
    expect(slot.getByTestId("main-agent").textContent).toContain(en.mainAgent);
    expect(slot.getByTestId("main-agent").textContent).not.toMatch(/spawn|compiled/i);
    slot.lifecycle.unmount();
  });

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

  it("shows a CAS conflict instead of silently overwriting", async () => {
    const slot = await mountPage({
      save_setting: () => ({ ok: false, conflict: true, version: 3, value: "other" }),
    });
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const sw = openRole(slot, "writer").querySelector("[data-testid='jev-settings'] [role='switch']") as HTMLButtonElement;
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
    fireEvent.click(openRole(slot, "writer").querySelector("[data-testid='jev-settings'] [role='switch']") as HTMLButtonElement);
    await slot.findByTestId("setting-validation-error");
    expect(slot.getByText(ru.validationInvalidChoice.replace("{key}", "writer.provider").replace("{allowed}", "agy, grok, qwen"))).toBeTruthy();
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps the writer selection in one native catalog picker", async () => {
    const slot = await mountPage();
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    // Every model picker sits in the Team table, one row per role; the Work tab keeps the policies and no picker.
    const team = slot.getByTestId("team-panel");
    const work = slot.getByTestId("work-panel");
    expect(team.querySelector("[data-testid='writer-picker'] [data-testid='bb-provider-model-picker']")).not.toBeNull();
    expect(openRole(slot, "writer").querySelector("[data-testid='writer-effort-mode']")).not.toBeNull();
    expect(team.querySelector("[data-testid='access-role-writer'] [data-testid='browser-qa-host']")).toBeNull();
    expect(team.querySelector("[data-testid='access-role-browser_qa'] [data-testid='browser-qa-host']")).not.toBeNull();
    expect(team.querySelector("[data-testid='access-role-night_reviewer'] [data-testid='night-review-settings']")).not.toBeNull();
    expect(work.querySelector("[data-testid='bb-provider-model-picker']")).toBeNull();
    expect(work.querySelector("[data-testid='writer-picker']")).toBeNull();
    expect(work.querySelector("[data-testid='browser-qa-host']")).toBeNull();
    expect(work.querySelector("[data-testid='night-review-settings']")).toBeNull();
    expect(slot.container.querySelector("[data-testid='field-s004']")).toBeNull();
    expect(slot.container.querySelector("[data-testid='field-s022']")).toBeNull();
    expect(slot.container.querySelector("[data-testid='field-s023']")).toBeNull();
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
    fireEvent.click(slot.getByRole("option", { name: en.enumWorkspaceWorktree }));
    await waitFor(() => expect(saved).toContainEqual(expect.objectContaining({ key:"adoc.040", value:"worktree" })));
    expect(openRole(slot, "browser_qa").querySelector("[data-testid='browser-qa-host-select']")).toBeTruthy();
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
    const slot = await mountPage({ stack_detect: missingStack });
    openTab(slot, "service");
    fireEvent.click(await slot.findByTestId("stack-detect"));
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

  it("offers only the Lane Stack check until it finds something to do, and rollback only with a snapshot", async () => {
    const base = screenFixture();
    const slot = await mountPage({ get_screen: () => ({ ...base, lastSnapshotPath: null }) });
    openTab(slot, "service");
    await slot.findByTestId("stack-detect");
    expect(slot.queryByTestId("install-stack")).toBeNull();
    expect(slot.queryByTestId("connect-opencode")).toBeNull();
    expect(slot.queryByTestId("stack-rollback")).toBeNull();
    fireEvent.click(slot.getByTestId("stack-detect"));
    // Installed at the target version: nothing to install; OpenCode without the plugin can be connected.
    await slot.findByTestId("stack-detect-result");
    expect(slot.queryByTestId("install-stack")).toBeNull();
    expect(slot.getByTestId("connect-opencode")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows the machine's Lane Pilot state and offers an install only when it is missing", async () => {
    const started: unknown[] = [];
    const base = screenFixture();
    const withBinding = { ...base, writerBinding: { status:"resolved", hostId:"host_ui", path:"/tmp/lane-pilot-ui", source:"session", bindings:[] } };
    let status = "absent";
    const slot = await mountPage({
      get_screen: () => withBinding,
      native_install_status: () => ({ status, error: null }),
      native_install_start: (input) => { started.push(input); status = "installing"; return { started: true }; },
    });
    openTab(slot, "service");
    await waitFor(() => expect(slot.getByTestId("native-install-state").dataset.state).toBe("todo"), { timeout: 5000 });
    fireEvent.click(slot.getByTestId("native-install-now"));
    await waitFor(() => expect(started).toEqual([{ hostId:"host_ui" }]), { timeout: 5000 });
    await waitFor(() => expect(slot.getByTestId("native-install-state").textContent).toContain(en.nativeInstalling), { timeout: 5000 });
    expect(slot.queryByTestId("native-install-now")).toBeNull();
    slot.lifecycle.unmount();
    status = "enabled";
    const ready = await mountPage({ get_screen: () => withBinding, native_install_status: () => ({ status, error: null }) });
    openTab(ready, "service");
    await waitFor(() => expect(ready.getByTestId("native-install-state").dataset.state).toBe("ok"), { timeout: 5000 });
    expect(ready.queryByTestId("native-install-now")).toBeNull();
    ready.lifecycle.unmount();
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

  it("shows writer output and installation receipts only in Maintenance technical details", async () => {
    const slot = await mountPage({}, { projectId:"proj_ui", threadId:null }, "", false);
    openTab(slot, "monitor");
    expect(slot.queryByTestId("writer-result")).toBeNull();
    openTab(slot, "service");
    const preview = await slot.findByTestId("cli-preview");
    const previewJson = JSON.parse(preview.querySelector("code")!.textContent!) as { argv:string[] };
    expect(previewJson.argv.filter((arg) => arg === "--provider")).toHaveLength(1);
    expect(previewJson.argv).toContain("fast");
    const writer = await slot.findByTestId("writer-result");
    expect(writer.textContent).toContain("hello from writer");
    expect(slot.getByTestId("diagnostics-panel").textContent).toContain("\"action\":\"install\"");
    // Maintenance keeps the technical details folded under the install actions.
    expect(slot.getByTestId("diagnostics-disclosure").hasAttribute("open")).toBe(false);
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
    openTab(slot, "service");
    fireEvent.click(await slot.findByTestId("stack-detect"));
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

  it("lists the runs in progress apart from the history, newest first, and opens the history 20 at a time", async () => {
    const base = screenFixture();
    const run = (id: string, state: string, updated: number) => ({ ...base.runs[0]!, id, state, updated_at: updated, attempts: [], stageCount: 0 });
    base.runs = [run("lprun_old", "closed", 1), ...Array.from({ length: 21 }, (_, i) => run(`lprun_h${i}`, "closed", 100 + i)), run("lprun_live", "running", 2)];
    const slot = await mountPage({ get_screen: () => base });
    openTab(slot, "monitor");
    // Active: only what is in progress; the closed runs wait in the history.
    const active = await slot.findByTestId("run-list");
    expect(Array.from(active.children).map((card) => card.getAttribute("data-testid"))).toEqual(["run-lprun_live"]);
    expect(slot.queryByTestId("runs-show-more")).toBeNull();
    openTab(slot, "monitor", "history");
    const list = await slot.findByTestId("run-list");
    const ids = () => Array.from(list.children).map((card) => card.getAttribute("data-testid"));
    expect(ids()[0]).toBe("run-lprun_h20");
    expect(ids()).not.toContain("run-lprun_live");
    expect(ids()).toHaveLength(20);
    fireEvent.click(slot.getByTestId("runs-show-more"));
    await waitFor(() => expect(ids()).toHaveLength(22));
    expect(ids().at(-1)).toBe("run-lprun_old");
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

  it("shows a loading state on the overview until the screen arrives, never the defaults", async () => {
    let release: (value: unknown) => void = () => undefined;
    const slot = await mountPage({ get_screen: () => new Promise((resolve) => { release = resolve; }) }, { projectId:"proj_ui", threadId:null }, "", false);
    await slot.findByTestId("overview-loading");
    expect(slot.getByTestId("overview-panel").textContent).not.toContain(en.overviewWriterMissing);
    expect(slot.getByTestId("overview-panel").textContent).not.toContain(en.overviewNoRuns);
    release(screenFixture());
    await slot.findByTestId("status-writer");
    expect(slot.queryByTestId("overview-loading")).toBeNull();
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

  // One page mount per scenario: five mounts in a single test outran the 5 s budget.
  it.each([
    { runState:"closed", attemptState:"accepted", cancel:false, retry:false },
    { runState:"closed", attemptState:"validation_failed", cancel:false, retry:false },
    { runState:"running", attemptState:"queued", cancel:true, retry:false },
    { runState:"running", attemptState:"running", cancel:true, retry:false },
    { runState:"running", attemptState:"validation_failed", cancel:false, retry:true },
  ])("shows only legal cancel and retry actions (run $runState, attempt $attemptState)", async (scenario) => {
    {
      const base = screenFixture();
      const run = base.runs[0]!;
      run.state = scenario.runState;
      run.attempts[0]!.state = scenario.attemptState;
      (run.attempts[0]! as {thread_id:string|null}).thread_id = scenario.attemptState === "queued" ? null : "thr_writer";
      const slot = await mountPage({ get_screen:() => base });
      // A run in progress is listed under Active, a closed one in the History.
      openTab(slot, "monitor", scenario.runState === "closed" ? "history" : "active");
      const row = await slot.findByTestId("attempt-lpattempt_1");
      const buttons = Array.from(row.querySelectorAll("button")).map((button) => button.textContent);
      expect(buttons.includes(en.cancel)).toBe(scenario.cancel);
      expect(buttons.includes(en.retry)).toBe(scenario.retry);
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
    await waitFor(() => expect(slot.getByTestId("tab-work").textContent).toBe(ru.tabWork));
    openTab(slot, "monitor");
    expect(slot.getAllByText(ru.state_running).length).toBeGreaterThan(0);
    openTab(slot, "service");
    expect(slot.getAllByText(new RegExp(ru.unappliedNoChannel)).length).toBeGreaterThan(0);
    slot.lifecycle.unmount();
  });

  it("does not leak the locale into document.lang", async () => {
    document.documentElement.lang = "en";
    const base = screenFixture();
    const first = await mountPage({
      get_preferences: () => ({ locale:"ru", preference:"ru", lastProjectId:null }),
    });
    await waitFor(() => expect(first.getByTestId("tab-work").textContent).toBe(ru.tabWork));
    expect(document.documentElement.lang).toBe("en");
    first.lifecycle.unmount();
    setLocaleOverride(null);
    const second = await mountPage({
      get_screen: () => ({ ...base, projectId: "proj_other", values: { ...base.values } }),
    });
    await waitFor(() => expect(second.getByTestId("tab-work").textContent).toBe(en.tabWork));
    expect(second.queryByText(ru.tabWork)).toBeNull();
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
    }, { projectId:"proj_ui", threadId:null }, "", false);
    openTab(slot, "monitor");
    expect(slot.queryByTestId("cli-receipt-lpattempt_a")).toBeNull();
    openTab(slot, "service");
    expect((await slot.findByTestId("cli-receipt-lpattempt_a")).textContent).toContain("first");
    expect((await slot.findByTestId("cli-receipt-lpattempt_b")).textContent).toContain("second");
    slot.lifecycle.unmount();
  });

  it("shows the legacy fast-mode mapping in Diagnostics instead of a separate switch", async () => {
    const slot = await mountPage();
    openTab(slot, "service");
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
    const field = await slot.findByTestId("night-review-policy").then((panel) => panel.querySelector("[data-testid='field-s006']") as HTMLElement);
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
    const input = slot.getByTestId("night-review-policy").querySelector("[data-testid='field-s006'] input[type='number']") as HTMLInputElement;
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
    const input = slot.getByTestId("night-review-policy").querySelector("[data-testid='field-s006'] input[type='number']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    await slot.findByTestId("cas-conflict");
    expect(input.value).toBe("10");
    slot.lifecycle.unmount();
  });

  it("keeps picker keys off the settings list and shows the advanced rows on demand", async () => {
    const slot = await mountPage();
    openTab(slot, "work");
    expect(slot.getByTestId("work-panel").querySelector("[data-testid='field-s004']")).toBeNull();
    expect(slot.getByTestId("settings-execution")).toBeTruthy();
    expect(slot.getByTestId("team-panel").querySelector("[data-testid='browser-qa-host']")).toBeTruthy();
    expect(slot.queryByTestId("settings-search")).toBeNull();
    expect(slot.getByTestId("work-night").hidden).toBe(true);
    openTab(slot, "knowledge", "memory");
    expect(slot.getByTestId("memory-advanced").hidden).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: en.settingsAdvanced }));
    expect(slot.getByTestId("settings-group-workspace")).toBeTruthy();
    expect(slot.getByTestId("work-night").hidden).toBe(false);
    expect(slot.getByTestId("memory-advanced").hidden).toBe(false);
    expect(slot.getByTestId("memory-advanced").textContent).toContain(en.settingMemoryMaintain);
    expect(slot.getByTestId("memory-advanced").textContent).toContain(en.fieldUnitTokens);
    expect(slot.getByTestId("memory-advanced").textContent).not.toContain("memory.core_budget");
    expect(slot.getByTestId("work-panel").querySelector("[data-testid='settings-group-memory']")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("switches the new settings chrome in Russian", async () => {
    Object.defineProperty(navigator, "language", { configurable: true, value: "ru-RU" });
    setLocaleOverride(null);
    document.documentElement.lang = "ru";
    const slot = await mountPage({
      get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }),
    });
    openTab(slot, "work");
    expect(slot.getByTestId("settings-depth").textContent).toContain(ru.settingsBasic);
    expect(slot.getByTestId("settings-depth").textContent).toContain(ru.settingsAdvanced);
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
    openTab(slot, "work");
    fireEvent.click(slot.getByRole("button", { name: en.settingsAdvanced }));
    const row = slot.getByTestId("field-s371");
    await waitFor(() => expect(row.textContent).toContain("Set on this project"));
    fireEvent.click(within(row).getByRole("button", { name: "Reset to inherited" }));
    await waitFor(() => expect(row.textContent).toContain("Inherited"));
    expect(row.textContent).not.toContain("Set on this project");
    expect(within(row).queryByRole("button", { name: "Reset to inherited" })).toBeNull();
    expect(slot.getByTestId("field-s371").textContent).toContain("project tree");
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
