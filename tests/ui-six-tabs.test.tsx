/** @vitest-environment jsdom */
import { HUB_KEYS } from "@lane-pilot/settings-catalog";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { SETTINGS_REGISTRY } from "../src/rooms/settings-registry";
import { CONSOLE_SECTIONS, SEGMENTS, SYSTEM_PAGES, resolveTab } from "../src/rooms/pages/models/nav-model";
import { extraSettingTab } from "../src/rooms/pages/models/placement";
import { setLocaleOverride, en } from "@lane-pilot/i18n";
import { HELPER_ROLES } from "../src/rooms/contracts/helper-context";
import { ROLE_GROUPS } from "../src/rooms/native-agent/ui/team-model";
import { screenFixture, mountPage } from "./ui-harness";
import { roomFaceRelative } from "./support/room-files";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
configure({ asyncUtilTimeout: 10_000 });

/** The storage keys a rendered panel shows: a field carries its own, a role row lists the keys it covers. */
function keysIn(panel: HTMLElement): string[] {
  const own = Array.from(panel.querySelectorAll<HTMLElement>("[data-storage-key]")).map((node) => node.getAttribute("data-storage-key")!);
  const listed = Array.from(panel.querySelectorAll<HTMLElement>("[data-lp-keys]")).flatMap((node) => node.getAttribute("data-lp-keys")!.split(" ").filter(Boolean));
  return [...own, ...listed];
}

describe("console setting routes and dictionaries", () => {
  beforeEach(() => { cleanup(); document.body.innerHTML = ""; });
  afterEach(() => { cleanup(); setLocaleOverride(null); document.documentElement.lang = "en"; });

  it("renders every setting row of the catalog across the console setting routes without duplicates", async () => {
    const base = screenFixture();
    // The access mode «only selected» also shows its four lists; Advanced depth shows the rest.
    const slot = await mountPage(
      {
        get_screen: () => ({ ...base, values: { ...base.values, "helper.context_mode": "selected" } }),
        helper_access_view: () => ({ mode: "selected", modeOrigin: null, roles: [], catalog: { bbPlugins: [], skills: [] }, mandatory: { bbPlugins: [], mcpServers: [] }, providers: {} }),
        workflow_list: () => ({ workflows: [], problems: [], project: "ok" }),
        schedule_list: () => ({ schedules: [], hosts: [], now: Date.now() }),
        list_sections: () => ({ sections: [] }),
        list_agents: () => ({ agents: [] }),
        get_role_models: () => ({ roles: [] }),
        workflow_model_catalog: () => ({ providers: [] }),
        get_routing_hint: () => ({ current: null, stats: [] }),
        specialist_overview: () => ({ breakers: [], pendingIntents: 0, dispatchedCount: 0, openQuestionsCount: 0, artifactsCount: 0, spend30dUsd: 0 }),
        owner_waiting: () => ({ items: [], now: 0 }),
      },
      { projectId: "proj_ui", threadId: null },
      "",
      false,
    );

    fireEvent.click(await slot.findByTestId("console-nav-system-settings"));
    await slot.findByTestId("system-settings");

    const seen = new Map<string, Set<string>>();
    const note = (route: string, panel: HTMLElement) => {
      for (const key of keysIn(panel)) seen.set(key, (seen.get(key) ?? new Set<string>()).add(route));
    };

    note("work", slot.getByTestId("work-panel-body"));
    for (const part of SEGMENTS.knowledge) {
      fireEvent.click(slot.getByTestId(`settings-nav-${part}`));
      await waitFor(() => expect(slot.getByTestId(`settings-${part}`)).toBeTruthy());
      note("knowledge", slot.getByTestId(`settings-${part}`));
    }

    fireEvent.click(slot.getByTestId("console-nav-system-agents"));
    await slot.findByTestId("system-agents");
    note("agents", slot.getByTestId("system-agents"));

    fireEvent.click(slot.getByTestId("console-nav-system-health"));
    await slot.findByTestId("service-panel");
    note("health", slot.getByTestId("service-panel"));

    // Hub self-improvement keys have their own page; `workflow.*` presets lived in AutomationTab while `system/graphs` mounts `WorkflowsScreen`.
    const wanted = [...new Set(SETTINGS_REGISTRY.visible.map((row) => row.storageKey))]
      .filter((key) => !HUB_KEYS.has(key) && extraSettingTab(key) !== "automation");
    const missing = wanted.filter((key) => !seen.has(key));
    const several = wanted.filter((key) => (seen.get(key)?.size ?? 0) > 1).map((key) => `${key}: ${[...seen.get(key)!].join(", ")}`);
    const home = (key: string) => [...(seen.get(key) ?? [])];
    expect(home("writer.model")).toEqual(["agents"]);
    expect(home("plan_critique.mode")).toEqual(["work"]);
    expect(home("memory.maintain")).toEqual(["knowledge"]);
    expect(home("writer.fast_mode")).toEqual(["health"]);
    expect(home("baseline.already_built")).toEqual(["work"]);
    expect(wanted.length).toBeGreaterThan(120);
    expect(missing, `catalog rows shown in no route: ${missing.join(", ")}`).toEqual([]);
    expect(several, "catalog rows shown in more than one route").toEqual([]);
    slot.lifecycle.unmount();
  });

  it("keeps the six console sections and six system pages across project and system scope", async () => {
    const slot = await mountPage(
      {
        list_sections: () => ({ sections: [] }),
        get_routing_hint: () => ({ current: null, stats: [] }),
        specialist_overview: () => ({ breakers: [], pendingIntents: 0, dispatchedCount: 0, openQuestionsCount: 0, artifactsCount: 0, spend30dUsd: 0 }),
        owner_waiting: () => ({ items: [], now: 0 }),
      },
      { projectId: "proj_ui", threadId: null },
      "",
      false,
    );
    await slot.findByTestId("console-shell");
    for (const id of CONSOLE_SECTIONS) expect(slot.getByTestId(`console-nav-${id}`)).toBeTruthy();
    for (const id of SYSTEM_PAGES) expect(slot.getByTestId(`console-nav-system-${id}`)).toBeTruthy();

    fireEvent.click(slot.getByTestId("console-nav-system-settings"));
    await slot.findByTestId("system-settings");
    fireEvent.click(slot.getByTestId("scope-switcher"));
    fireEvent.click(await slot.findByTestId("scope-all"));

    await waitFor(() => expect(slot.getByTestId("settings-screen").textContent).toContain(en.globalsHelp));
    for (const id of CONSOLE_SECTIONS) expect(slot.getByTestId(`console-nav-${id}`)).toBeTruthy();
    for (const id of SYSTEM_PAGES) expect(slot.getByTestId(`console-nav-system-${id}`)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("keeps the old tab ids as aliases", () => {
    expect(resolveTab("checks")).toEqual({ tab: "work" });
    expect(resolveTab("access")).toEqual({ tab: "team" });
    expect(resolveTab("service")).toEqual({ tab: "runs", segment: "service" });
    expect(resolveTab("monitor")).toEqual({ tab: "runs", segment: "board" });
    expect(resolveTab("team")).toEqual({ tab: "team" });
  });

  it("lists every helper role in the team table once", () => {
    const listed = ROLE_GROUPS.flatMap((group) => group.roles.map((role) => role.id));
    expect(new Set(listed).size).toBe(listed.length);
    expect([...HELPER_ROLES].filter((role) => !listed.includes(role))).toEqual([]);
    // The scouts' seats are model rows of the one scout helper (its rights): the only rows that are not a helper role.
    expect(listed.filter((role) => !(HELPER_ROLES as readonly string[]).includes(role))).toEqual(["scout-2", "scout-3"]);
  });

  it("picks no string by `ru ? … : …` in the UI: every text comes from the dictionaries", () => {
    const offenders = roomFaceRelative("ui")
      .filter((file) => /\bru\s*\?\s*["'`(]/.test(readFileSync(join(process.cwd(), file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
