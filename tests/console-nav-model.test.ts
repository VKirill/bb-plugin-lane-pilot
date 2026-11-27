import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { describe, expect, it } from "vitest";
import {
  CONSOLE_SECTIONS,
  LEGACY_SCOPES,
  LEGACY_TABS,
  SECTION_VIEWS,
  STAFF_TABS,
  SYSTEM_PAGES,
  buildConsolePath,
  parseConsoleRoute,
  resolveLegacyRoute,
  type ConsoleRoute,
} from "../src/rooms/pages/models";

describe("console nav-model", () => {
  it("parses empty and unknown paths to overview", () => {
    expect(parseConsoleRoute("")).toEqual({ section: "overview" });
    expect(parseConsoleRoute("/")).toEqual({ section: "overview" });
    expect(parseConsoleRoute("   ")).toEqual({ section: "overview" });
    expect(parseConsoleRoute("does-not-exist")).toEqual({ section: "overview" });
    expect(parseConsoleRoute("does-not-exist/nested/path")).toEqual({ section: "overview" });
    expect(resolveLegacyRoute("does-not-exist")).toBeNull();
    expect(resolveLegacyRoute("proj-1/nonexistent-tab")).toBeNull();
  });

  it("round-trips parse(build(route)) for every grammar line", () => {
    const routes: ConsoleRoute[] = [
      { section: "overview" },
      { section: "decisions" },
      ...SECTION_VIEWS.decisions.map((view): ConsoleRoute => ({ section: "decisions", view })),
      { section: "staff" },
      { section: "staff", view: "hire" },
      { section: "staff", staffRef: { projectId: "proj-1", domain: "marketing" } },
      ...STAFF_TABS.map((view): ConsoleRoute => ({
        section: "staff",
        staffRef: { projectId: "proj-1", domain: "seo" },
        view,
      })),
      { section: "work" },
      ...SECTION_VIEWS.work.map((view): ConsoleRoute => ({ section: "work", view })),
      { section: "work", taskRef: { runId: "run-42", taskId: "task-7" } },
      { section: "memory" },
      ...SECTION_VIEWS.memory.map((view): ConsoleRoute => ({ section: "memory", view })),
      { section: "system" },
      ...SYSTEM_PAGES.map((page): ConsoleRoute => ({ section: "system", page })),
      { section: "system", page: "graphs", view: "wf-1/draft" },
      { section: "system", page: "schedules", view: "sched-9" },
    ];

    for (const route of routes) {
      const path = buildConsolePath(route);
      expect(parseConsoleRoute(path), `round-trip for ${path}`).toEqual(route);
    }
    expect(CONSOLE_SECTIONS).toEqual(["overview", "decisions", "staff", "work", "memory", "system"]);
  });

  it("parses staff/<p>/<d>/loadout with staffRef and view", () => {
    expect(parseConsoleRoute("staff/alpha/writer/loadout")).toEqual({
      section: "staff",
      staffRef: { projectId: "alpha", domain: "writer" },
      view: "loadout",
    });
    expect(parseConsoleRoute("/staff/alpha/writer/")).toEqual({
      section: "staff",
      staffRef: { projectId: "alpha", domain: "writer" },
    });
  });

  it("resolves every row of the legacy route table with and without projectId", () => {
    const cases: Array<[string, Omit<ConsoleRoute, "projectId">]> = [
      ["overview", { section: "overview" }],
      ["team", { section: "system", page: "agents" }],
      ["access", { section: "system", page: "agents" }],
      ["work", { section: "system", page: "settings" }],
      ["settings", { section: "system", page: "settings" }],
      ["checks", { section: "system", page: "settings" }],
      ["knowledge/memory", { section: "memory", view: "records" }],
      ["memory", { section: "memory", view: "records" }],
      ["knowledge/docs", { section: "system", page: "settings", view: "docs" }],
      ["automation/workflows", { section: "system", page: "graphs" }],
      ["workflows", { section: "system", page: "graphs" }],
      ["automation/schedule", { section: "system", page: "schedules" }],
      ["schedule", { section: "system", page: "schedules" }],
      ["runs/board", { section: "work", view: "tasks" }],
      ["monitor", { section: "work", view: "tasks" }],
      ["runs/analytics", { section: "system", page: "costs", view: "quality" }],
      ["runs/service", { section: "system", page: "health" }],
      ["service", { section: "system", page: "health" }],
    ];

    for (const [legacy, expected] of cases) {
      expect(resolveLegacyRoute(legacy), `bare ${legacy}`).toEqual(expected);
      expect(resolveLegacyRoute(`proj-1/${legacy}`), `scoped proj-1/${legacy}`).toEqual({
        ...expected,
        projectId: "proj-1",
      });
      expect(parseConsoleRoute(`proj-1/${legacy}`), `parse proj-1/${legacy}`).toEqual({
        ...expected,
        projectId: "proj-1",
      });
    }

    // Every LEGACY_TABS key must resolve via resolveLegacyRoute.
    for (const key of Object.keys(LEGACY_TABS)) {
      expect(resolveLegacyRoute(key), `LEGACY_TABS.${key}`).not.toBeNull();
      expect(resolveLegacyRoute(`proj-1/${key}`), `proj-1/${key}`).not.toBeNull();
    }
  });

  it("maps every legacy scope value", () => {
    expect(LEGACY_SCOPES).toEqual({
      waiting: { section: "decisions", view: "waiting" },
      tasks: { section: "work", view: "tasks" },
      errands: { section: "work", view: "errands" },
      schedule: { section: "system", page: "schedules" },
      globals: { section: "system", page: "settings", projectId: GLOBAL_SETTINGS_PROJECT_ID },
      agents: { section: "system", page: "agents" },
      workflows: { section: "system", page: "graphs" },
      tokens: { section: "system", page: "costs" },
      projects: { section: "overview" },
    });
  });
});
