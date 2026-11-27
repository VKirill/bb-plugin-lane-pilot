/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { en, setLocaleOverride } from "@lane-pilot/i18n";
import { isTestProject, splitProjects, writeHiddenProjects } from "../src/rooms/pages/ui/service-projects";
import { mountPage } from "./ui-harness";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
configure({ asyncUtilTimeout: 10_000 });

const PROJECTS = [
  { id: "proj_ui", name: "UI test" },
  { id: "proj_3tb652jpsi", name: "Sandbox of the checks" },
  { id: "proj_n1", name: "LP native NOGIT" },
  { id: "proj_s1", name: "LP sandbox rules" },
  { id: "proj_work", name: "Work project" },
];

const projectsRpc = {
  list_projects: () => ({ projects: PROJECTS, lastProjectId: "proj_ui" }),
  list_sections: () => ({ sections: [] }),
  get_routing_hint: () => ({ current: null, stats: [] }),
  specialist_overview: () => ({ breakers: [], pendingIntents: 0, dispatchedCount: 0, openQuestionsCount: 0, artifactsCount: 0, spend30dUsd: 0 }),
  owner_waiting: () => ({ items: [], now: 0 }),
};

describe("service projects", () => {
  it("tells test projects by id and by name pattern, and keeps the rest", () => {
    expect(PROJECTS.filter(isTestProject).map((project) => project.id)).toEqual(["proj_3tb652jpsi", "proj_n1", "proj_s1"]);
    // The bench's projects («LP bench <project>», src/rooms/bench) are service projects too.
    expect(isTestProject({ id: "proj_b1", name: "LP bench SelfyStudio" })).toBe(true);
    const { main, service } = splitProjects(PROJECTS, new Set(["proj_work"]));
    expect(main.map((project) => project.id)).toEqual(["proj_ui"]);
    expect(service.map((project) => project.id)).toEqual(["proj_3tb652jpsi", "proj_n1", "proj_s1", "proj_work"]);
  });
});

const storage = new Map<string, string>();
const memoryStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); },
  clear: () => { storage.clear(); },
  key: (i: number) => [...storage.keys()][i] ?? null,
  get length() { return storage.size; },
};

describe("project list, header and overview", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    storage.clear();
    if (!globalThis.localStorage) vi.stubGlobal("localStorage", memoryStorage);
    else globalThis.localStorage.clear();
  });
  afterEach(() => { cleanup(); setLocaleOverride(null); document.documentElement.lang = "en"; vi.unstubAllGlobals(); });

  it("folds test projects under «Service projects» in the scope switcher and respects hidden projects", async () => {
    const slot = await mountPage(projectsRpc, { projectId: "proj_ui", threadId: null }, "", false);
    fireEvent.click(await slot.findByTestId("scope-switcher"));
    const folded = await slot.findByTestId("service-projects");
    expect(folded.textContent).toContain(`${en.navGroupService} (3)`);
    expect(folded.querySelector("[data-testid='scope-project-proj_n1']")).not.toBeNull();
    expect(folded.querySelector("[data-testid='scope-project-proj_s1']")).not.toBeNull();
    expect(folded.querySelector("[data-testid='scope-project-proj_3tb652jpsi']")).not.toBeNull();
    expect(folded.hasAttribute("open")).toBe(false);

    // Persisting a hidden project id moves it under «Service projects» when the switcher reopens.
    writeHiddenProjects(["proj_work"]);
    fireEvent.keyDown(slot.getByRole("listbox"), { key: "Escape" });
    fireEvent.click(slot.getByTestId("scope-switcher"));
    await waitFor(() => expect(slot.getByTestId("service-projects").textContent).toContain(`${en.navGroupService} (4)`));
    expect(slot.getByTestId("service-projects").querySelector("[data-testid='scope-project-proj_work']")).not.toBeNull();
    slot.lifecycle.unmount();
  });

});

describe("default route and system settings scope", () => {
  beforeEach(() => { cleanup(); document.body.innerHTML = ""; });
  afterEach(() => { cleanup(); setLocaleOverride(null); document.documentElement.lang = "en"; });

  it("opens Overview by default without a project, and renders General settings on System -> Settings when no project is selected", async () => {
    const own = await mountPage(projectsRpc, { projectId: null, threadId: null }, "", false);
    await own.findByTestId("console-overview");
    expect(own.getByTestId("console-nav-overview").getAttribute("aria-current")).toBe("page");
    fireEvent.click(own.getByTestId("console-nav-system-settings"));
    await waitFor(() => expect(own.getByTestId("settings-screen").textContent).toContain(en.globalsHelp));
    own.lifecycle.unmount();

    const inProject = await mountPage(projectsRpc, { projectId: "proj_ui", threadId: null }, "", false);
    fireEvent.click(await inProject.findByTestId("console-nav-system-settings"));
    await waitFor(() => expect(inProject.getByTestId("settings-screen").textContent).toContain("UI test"));
    inProject.lifecycle.unmount();
  });
});

describe("Work has an «Errands» view", () => {
  beforeEach(() => { cleanup(); document.body.innerHTML = ""; });
  afterEach(() => { cleanup(); setLocaleOverride(null); document.documentElement.lang = "en"; });

  it("opens the Errands screen from Work", async () => {
    const slot = await mountPage(
      { ...projectsRpc, errands_overview: () => ({ days: 7, kinds: [], errands: [] }) },
      { projectId: null, threadId: null },
      "",
      false,
    );
    fireEvent.click(await slot.findByTestId("console-nav-work"));
    fireEvent.click(await slot.findByTestId("seg-work-view-errands"));
    await slot.findByTestId("errands-screen");
    await slot.findByTestId("errands-empty");
    slot.lifecycle.unmount();
  });
});
