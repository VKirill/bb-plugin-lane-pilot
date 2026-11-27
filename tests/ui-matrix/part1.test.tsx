/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { openAllTabs, openTab } from "../ui-tabs";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { mountPage, screenFixture } from "../ui-harness";
import { en, ru, setLocaleOverride } from "@lane-pilot/i18n";
import { useMatrixHooks } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

describe("Lane Pilot UI", () => {
  useMatrixHooks();

  it("shows the selected project's settings immediately and remembers the rail selection", async () => {
    const remember = vi.fn(() => ({ ok:true }));
    const slot = await mountPage({
      list_projects: () => ({ projects:[{ id:"proj_ui", name:"UI test" }], lastProjectId:"proj_ui" }),
      remember_project: remember,
    }, { projectId:null, threadId:null });
    fireEvent.click(await slot.findByTestId("scope-switcher"));
    fireEvent.click(await slot.findByTestId("scope-project-proj_ui"));
    await openAllTabs(slot);
    openTab(slot, "team");
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    expect(remember).toHaveBeenCalledWith({ projectId:"proj_ui" });
    expect(slot.queryByRole("button", { name: "Open project" })).toBeNull();
    expect(slot.getByTestId("console-sidebar")).toBeTruthy();
    expect(slot.getByTestId("console-nav").querySelector(".grid")).toBeNull();
    expect(slot.getByTestId("main-agent").textContent).toContain(en.mainAgent);
    expect(slot.getByTestId("main-agent").textContent).not.toMatch(/spawn|compiled/i);
    openTab(slot, "work");
    expect(slot.getByTestId("work-panel-body").closest("[data-testid='system-settings']")).toBeTruthy();
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

  it("shows a loading state on the overview until the screen arrives, never the defaults", async () => {
    let release: (value: unknown) => void = () => undefined;
    const slot = await mountPage({ console_overview: () => new Promise((resolve) => { release = resolve; }) }, { projectId:"proj_ui", threadId:null }, "", false);
    await slot.findByTestId("overview-loading");
    expect(slot.getByTestId("console-overview").textContent).not.toContain(en.consoleOverviewActiveEmpty);
    release({
      tz: "UTC",
      counts: { active: 0, waiting: 0, closedToday: 0, spendTodayUsd: null, goalsOnTrack: 0, goalsTotal: 0 },
      active: [],
      closedByDay: [],
      goals: [],
      costCoverage: 1,
    });
    await slot.findByTestId("overview-kpis");
    expect(slot.queryByTestId("overview-loading")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("does not leak the locale into document.lang", async () => {
    document.documentElement.lang = "en";
    const base = screenFixture();
    const first = await mountPage({
      get_preferences: () => ({ locale:"ru", preference:"ru", lastProjectId:null }),
    });
    await waitFor(() => expect(first.getByTestId("console-nav-system-settings").textContent).toBe(ru.consoleSysSettings));
    expect(document.documentElement.lang).toBe("en");
    first.lifecycle.unmount();
    setLocaleOverride(null);
    const second = await mountPage({
      get_screen: () => ({ ...base, projectId: "proj_other", values: { ...base.values } }),
    });
    await waitFor(() => expect(second.getByTestId("console-nav-system-settings").textContent).toBe(en.consoleSysSettings));
    expect(second.queryByText(ru.consoleSysSettings)).toBeNull();
    second.lifecycle.unmount();
  });

  it("keeps the unsaved numeric draft on an external CAS conflict", async () => {
    const slot = await mountPage({
      save_setting: () => ({ ok: false, conflict: true, version: 9, value: 3 }),
    });
    openTab(slot, "work");
    await waitFor(() => expect(slot.getByTestId("code-critique-policy")).toBeTruthy());
    const input = slot.getByTestId("code-critique-policy").querySelector("[data-testid='field-s380'] input[type='number']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    await slot.findByTestId("cas-conflict");
    expect(input.value).toBe("10");
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
});
