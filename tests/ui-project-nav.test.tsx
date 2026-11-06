/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { en, setLocaleOverride } from "@lane-pilot/i18n";
import { isTestProject, splitProjects } from "../src/rooms/ui-shell/ui/service-projects";
import { screenFixture, mountPage } from "./ui-harness";
import { openTab } from "./ui-tabs";

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
const projectsRpc = { list_projects: () => ({ projects: PROJECTS, lastProjectId: "proj_ui" }) };

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

describe("project list, header and overview", () => {
  beforeEach(() => { cleanup(); document.body.innerHTML = ""; });
  afterEach(() => { cleanup(); setLocaleOverride(null); document.documentElement.lang = "en"; });

  it("folds the test projects under «Service projects» and hides a project on request", async () => {
    const slot = await mountPage(projectsRpc);
    const rail = await slot.findByTestId("scope-rail");
    const folded = slot.getByTestId("service-projects");
    expect(folded.textContent).toContain(`${en.navGroupService} (3)`);
    expect(folded.querySelector("[data-testid='project-item-proj_n1']")).not.toBeNull();
    expect(folded.querySelector("[data-testid='project-item-proj_s1']")).not.toBeNull();
    expect(folded.querySelector("[data-testid='project-item-proj_3tb652jpsi']")).not.toBeNull();
    expect(folded.hasAttribute("open")).toBe(false);
    expect(rail.querySelector("[data-testid='project-item-proj_ui']")?.closest("[data-testid='service-projects']")).toBeNull();
    expect(rail.querySelector("[data-testid='project-item-proj_work']")?.closest("[data-testid='service-projects']")).toBeNull();
    // The system pages sit in two groups apart from the projects: what needs the owner today, and the setup.
    expect(rail.textContent).toContain(en.navGroupToday);
    expect(rail.textContent).toContain(en.navGroupSetup);
    expect(slot.getByTestId("scope-nav-group-today").querySelector("[data-testid='scope-nav-waiting']")).not.toBeNull();
    expect(slot.getByTestId("scope-nav-group-setup").querySelector("[data-testid='scope-nav-workflows']")).not.toBeNull();

    fireEvent.click(slot.getByTestId("project-item-proj_work"));
    await slot.findByTestId("project-header");
    fireEvent.click(slot.getByTestId("project-menu"));
    fireEvent.click(await slot.findByTestId("project-hide"));
    await waitFor(() => expect(slot.getByTestId("service-projects").textContent).toContain(`${en.navGroupService} (4)`));
    expect(slot.getByTestId("service-projects").querySelector("[data-testid='project-item-proj_work']")).not.toBeNull();
    // A hidden project comes back from the system overview.
    fireEvent.click(slot.getByRole("tab", { name: en.navGlobals }));
    const hidden = await slot.findByTestId("hidden-projects");
    expect(hidden.textContent).toContain("Work project");
    fireEvent.click(hidden.querySelector("button")!);
    await waitFor(() => expect(slot.getByTestId("service-projects").textContent).toContain(`${en.navGroupService} (3)`));
    slot.lifecycle.unmount();
  });

  it("shows status chips in the header: runs in progress, the writer's model and the machine", async () => {
    const base = screenFixture();
    const slot = await mountPage({
      ...projectsRpc,
      get_screen: () => ({ ...base, writerBinding: { status: "resolved", hostId: "host_ui", path: "/tmp/lane-pilot-ui", source: "unique_source", bindings: [] } }),
    });
    const chips = await slot.findByTestId("project-chips");
    await waitFor(() => expect(chips.textContent).toContain("codex · test-model"));
    expect(slot.getByTestId("chip-runs").textContent).toBe(en.chipRunning.replace("{n}", "1"));
    expect(slot.getByTestId("chip-machine").textContent).toBe(`Writer · ${en.hostConnected}`);
    expect(slot.getByTestId("project-subline").textContent).toContain("/tmp/lane-pilot-ui");
    // The old «Selected project» card is gone: one H1, the project's name.
    expect(slot.getByTestId("project-header").querySelectorAll("h1").length).toBe(1);
    expect(slot.getByTestId("project-header").textContent).not.toContain(en.selectedProject);
    slot.lifecycle.unmount();
  });

  it("says what is going on, what needs the owner, and explains itself in a folded block", async () => {
    const slot = await mountPage(projectsRpc);
    await slot.findByTestId("runs-now");
    expect(slot.getByTestId("now-lprun_1")).toBeTruthy();
    expect(slot.getByTestId("needs-attention")).toBeTruthy();
    const how = slot.getByTestId("how-it-works");
    expect(how.tagName).toBe("DETAILS");
    expect(how.hasAttribute("open")).toBe(false);
    expect(how.textContent).toContain(en.howInheritTitle);
    expect(how.textContent).toContain(en.howFlowTitle);
    slot.lifecycle.unmount();
  });

  it("opens Runs, Service from the overview and from the project menu", async () => {
    const slot = await mountPage(projectsRpc);
    fireEvent.click((await slot.findByTestId("status-stack")).querySelector("button")!);
    await slot.findByTestId("service-panel");
    openTab(slot, "overview");
    fireEvent.click(slot.getByTestId("project-menu"));
    fireEvent.click(await slot.findByTestId("project-menu-service"));
    await slot.findByTestId("service-panel");
    expect(slot.getByTestId("seg-runs-service").getAttribute("aria-pressed")).toBe("true");
    slot.lifecycle.unmount();
  });
});

describe("the plugin's own page lands on General settings", () => {
  it("opens «General settings» when the route has no project, and the last project only when the route names one", async () => {
    const own = await mountPage(projectsRpc, { projectId: null, threadId: null });
    await waitFor(() => expect(own.getByTestId("project-settings").querySelector("h1")?.textContent).toBe(en.navGlobals));
    own.lifecycle.unmount();
    const inProject = await mountPage(projectsRpc);
    await waitFor(() => expect(inProject.getByTestId("project-settings").querySelector("h1")?.textContent).not.toBe(en.navGlobals));
    inProject.lifecycle.unmount();
  });
});

describe("the rail has an «Errands» page", () => {
  it("opens the Errands screen from the rail", async () => {
    const slot = await mountPage({ ...projectsRpc, errands_overview: () => ({ days: 7, kinds: [], errands: [] }) }, { projectId: null, threadId: null });
    await slot.findByTestId("project-settings");
    fireEvent.click(slot.getByRole("tab", { name: en.navErrands }));
    await slot.findByTestId("errands-screen");
    await slot.findByTestId("errands-empty");
    slot.lifecycle.unmount();
  });
});

describe("«Графы» takes the whole block", () => {
  beforeEach(() => { cleanup(); document.body.innerHTML = ""; });
  afterEach(() => { cleanup(); setLocaleOverride(null); document.documentElement.lang = "en"; });

  it("hides the section rail on a computer and brings it back with «Menu»", async () => {
    const slot = await mountPage(projectsRpc);
    fireEvent.click(await slot.findByTestId("scope-nav-workflows"));
    const shell = slot.getByTestId("project-picker");
    if (shell.dataset.lpChrome !== "rail") return; // a phone-width shell keeps its own compact picker
    await waitFor(() => expect(slot.queryByTestId("scope-rail")).toBeNull());
    fireEvent.click(slot.getByTestId("scope-rail-toggle"));
    expect(await slot.findByTestId("scope-rail")).toBeTruthy();
  });
});
