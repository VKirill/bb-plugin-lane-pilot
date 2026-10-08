/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";
import { SEGMENTS, TAB_IDS, resolveTab, segmentsFor } from "../src/rooms/ui-shell/ui/tabs-model";
import { setLocaleOverride, en, ru } from "@lane-pilot/i18n";
import { HELPER_ROLES } from "../src/rooms/native-agent/helper-context";
import { ROLE_GROUPS } from "../src/rooms/native-agent/ui/team-model";
import { screenFixture, mountPage } from "./ui-harness";
import { openTab } from "./ui-tabs";
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

describe("six tabs", () => {
  beforeEach(() => { cleanup(); document.body.innerHTML = ""; });
  afterEach(() => { cleanup(); setLocaleOverride(null); document.documentElement.lang = "en"; });

  it("renders every setting row of the catalog in exactly one tab", async () => {
    const base = screenFixture();
    // The access mode «only selected» also shows its four lists; the screen is read in the Advanced depth, which shows the rest.
    const slot = await mountPage({
      get_screen: () => ({ ...base, values: { ...base.values, "helper.context_mode": "selected" } }),
      helper_access_view: () => ({ mode: "selected", modeOrigin: null, roles: [], catalog: { bbPlugins: [], skills: [] }, mandatory: { bbPlugins: [], mcpServers: [] }, providers: {} }),
      workflow_list: () => ({ workflows: [], problems: [], project: "ok" }),
      schedule_list: () => ({ schedules: [], hosts: [], now: Date.now() }),
    });
    openTab(slot, "team");
    fireEvent.click(slot.getByTestId("settings-depth").querySelectorAll("button")[1]!);
    const seen = new Map<string, Set<string>>();
    const note = (tab: string) => {
      const panel = slot.getByTestId(`${tab}-panel`);
      for (const key of keysIn(panel)) seen.set(key, (seen.get(key) ?? new Set<string>()).add(tab));
    };
    for (const tab of ["team", "work", "knowledge", "automation", "runs"] as const) {
      openTab(slot, tab);
      const parts = tab in SEGMENTS ? segmentsFor(tab as keyof typeof SEGMENTS, "project") : [null];
      for (const part of parts) {
        if (part) fireEvent.click(slot.getByTestId(`seg-${tab}-${part}`));
        await waitFor(() => expect(slot.getByTestId(`${tab}-panel`)).toBeTruthy());
        note(tab);
      }
    }
    const wanted = [...new Set(VISIBLE_CATALOG.map((row) => row.storageKey))];
    const missing = wanted.filter((key) => !seen.has(key));
    const several = wanted.filter((key) => (seen.get(key)?.size ?? 0) > 1).map((key) => `${key}: ${[...seen.get(key)!].join(", ")}`);
    // Where a few well-known rows live (so the check above cannot pass by seeing nothing).
    const home = (key: string) => [...(seen.get(key) ?? [])];
    expect(home("writer.model")).toEqual(["team"]);
    expect(home("plan_critique.mode")).toEqual(["work"]);
    expect(home("memory.maintain")).toEqual(["knowledge"]);
    expect(home("workflow.agent.model")).toEqual(["automation"]);
    expect(home("ops.run_dir")).toEqual(["runs"]);
    expect(wanted.length).toBeGreaterThan(200);
    expect(missing, `catalog rows shown in no tab: ${missing.join(", ")}`).toEqual([]);
    expect(several, `catalog rows shown in more than one tab`).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("has the same six tabs on the system level, in a project and in a section", async () => {
    const slot = await mountPage();
    for (const id of TAB_IDS) expect(slot.getByTestId(`tab-${id}`)).toBeTruthy();
    expect(TAB_IDS).toEqual(["overview", "team", "work", "knowledge", "automation", "runs"]);
    fireEvent.click(slot.getByRole("tab", { name: en.navGlobals }));
    await waitFor(() => expect(slot.getByTestId("language-setting")).toBeTruthy());
    for (const id of TAB_IDS) expect(slot.getByTestId(`tab-${id}`)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("names the tabs in both languages and keeps the old tab ids as aliases", () => {
    for (const key of ["tabTeam", "tabWork", "tabKnowledge", "tabAutomation", "tabRuns"] as const) {
      expect(en[key]).toBeTruthy();
      expect(ru[key]).toBeTruthy();
      expect(ru[key]).not.toBe(en[key]);
    }
    expect(resolveTab("checks")).toEqual({ tab: "work" });
    expect(resolveTab("access")).toEqual({ tab: "team" });
    expect(resolveTab("service")).toEqual({ tab: "runs", segment: "service" });
    expect(resolveTab("monitor")).toEqual({ tab: "runs", segment: "active" });
    expect(resolveTab("team")).toEqual({ tab: "team" });
  });

  it("shows no segments that a level cannot use", () => {
    expect(segmentsFor("knowledge", "system")).toEqual(["memory", "docs", "anamnesis"]);
    expect(segmentsFor("knowledge", "project")).toEqual(["memory", "docs", "rules"]);
    expect(segmentsFor("knowledge", "section")).toEqual(["memory", "docs", "rules"]);
  });

  it("lists every helper role in the team table once", () => {
    const listed = ROLE_GROUPS.flatMap((group) => group.roles.map((role) => role.id));
    expect(new Set(listed).size).toBe(listed.length);
    expect([...HELPER_ROLES].filter((role) => !listed.includes(role))).toEqual([]);
    expect(listed.filter((role) => !(HELPER_ROLES as readonly string[]).includes(role))).toEqual([]);
  });

  it("picks no string by `ru ? … : …` in the UI: every text comes from the dictionaries", () => {
    const offenders = roomFaceRelative("ui")
      .filter((file) => /\bru\s*\?\s*["'`(]/.test(readFileSync(join(process.cwd(), file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
