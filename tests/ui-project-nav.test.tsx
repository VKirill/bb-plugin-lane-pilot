/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { en, setLocaleOverride } from "../i18n";
import { isTestProject, splitProjects } from "../src/ui/service-projects";
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
    // The system pages sit under their own heading, apart from the projects.
    expect(rail.textContent).toContain(en.navGroupSystem);

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
