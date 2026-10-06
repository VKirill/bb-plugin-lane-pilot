/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { installTestPluginRuntime, loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { openDatabase, savePrototypeConfig } from "../src/database";
import { ACCESS_GROUPS, ACCESS_SWITCHES, HELPER_ROLES, MANDATORY_BB_PLUGINS, MANDATORY_MCP_SERVERS, CORE_PROVIDER_GROUPS, effectiveGroup, effectiveSwitch, parseRoleAccess, roleAccessKey } from "../src/helper-context";
import { en, ru, setLocaleOverride } from "../i18n";
import plugin from "../server";

// The whole file takes 70-80 s on OVH and single tests near 15 s under a loaded machine (clean-clone run 2026-10-07).
vi.setConfig({ testTimeout: 60_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const projectId = "proj_access_ui";
const GLOBAL = "*";

type SaveCall = { projectId: string; sectionId?: string; key: string; value: unknown; expectedVersion: number };
type ResetCall = { projectId: string; sectionId?: string; keys: string[]; expectedVersions: Record<string, number> };
type Origin = "global" | "project" | "section";
// Sections of the fixture project: sec_a at the top, sec_b inside it.
const SECTIONS = [{ id: "sec_a", parentId: null, name: "Alpha", path: "alpha", kind: "folder" as const }, { id: "sec_b", parentId: "sec_a", name: "Beta", path: "alpha/beta", kind: "folder" as const }];

async function mount(options: { mode?: string; modeOrigin?: Origin | null; preset?: Record<string, unknown> } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { plugins: { list: async () => [] }, skills: { list: async () => [] }, projects: { get: async ({ projectId: id }) => ({ id, name: id, sources: [{ hostId: "h", path: "/tmp/access-ui", isDefault: true }] }), list: async () => [] } },
  });
  savePrototypeConfig(openDatabase(bb), { projectId, hostId: "h", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/access-ui", pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "g" });
  await plugin(bb);
  installTestPluginRuntime();
  // Rows per level: "*" (global), "project", then the section ids; a removed row keeps its version, as the database does.
  const rows: Record<string, Record<string, { value: unknown; version: number; present: boolean }>> = { [GLOBAL]: {}, project: {}, sec_a: {}, sec_b: {} };
  for (const [level, value] of Object.entries(options.preset ?? {})) rows[level]!["helper.access.writer"] = { value, version: 1, present: true };
  const saves: SaveCall[] = [];
  const resets: ResetCall[] = [];
  const views: Array<{ projectId: string; sectionId?: string }> = [];
  let mode = options.mode ?? "roles";
  const levelsOf = (pid: string, sectionId?: string): Array<[string, Origin]> => pid === GLOBAL ? [[GLOBAL, "global"]]
    : [[GLOBAL, "global"], ["project", "project"], ...(sectionId === "sec_b" ? [["sec_a", "section"], ["sec_b", "section"]] : sectionId ? [[sectionId, "section"]] : []) as Array<[string, Origin]>];
  const view = (pid: string, sectionId?: string) => {
    const levels = levelsOf(pid, sectionId);
    const own = rows[levels.at(-1)![0]]!;
    return {
      mode, modeOrigin: options.modeOrigin ?? null,
      roles: HELPER_ROLES.map((role) => {
        const key = roleAccessKey(role);
        let value: unknown = undefined; let origin: Origin | null = null;
        for (const [level, name] of levels) if (rows[level]![key]?.present) { value = rows[level]![key]!.value; origin = name; }
        const access = parseRoleAccess(value);
        return {
          role, key, version: own[key]?.version ?? 0, value: own[key]?.present ? own[key]!.value : null, inherited: !own[key]?.present && origin !== null, origin,
          groups: Object.fromEntries(ACCESS_GROUPS.map((group) => [group, effectiveGroup(role, group, access)])),
          switches: Object.fromEntries(ACCESS_SWITCHES.map((sw) => [sw, effectiveSwitch(sw, access)])),
        };
      }),
      catalog: {
        bbPlugins: [{ id: "browser-automation", name: "Browser Automation" }, { id: "image-studio", name: "Image Studio" }],
        skills: [{ name: "ru-text", description: "Russian text quality" }, { name: "tavily", description: "Web search" }, { name: "writer-practices", description: "Writing habits" }],
      },
      mandatory: { bbPlugins: [...MANDATORY_BB_PLUGINS], mcpServers: [...MANDATORY_MCP_SERVERS] },
      providers: Object.fromEntries(Object.entries(CORE_PROVIDER_GROUPS).map(([id, groups]) => [id, [...groups]])),
    };
  };
  const ownRows = (pid: string, sectionId?: string) => rows[levelsOf(pid, sectionId).at(-1)![0]]!;
  const app = await loadPluginApp(await import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    context: { projectId, threadId: null },
    providers: { status: "ready", providers: [] as never },
    rpc: {
      get_preferences: (input) => harness.behavior.callRpc("get_preferences", input) as Promise<unknown>,
      set_locale: (input) => harness.behavior.callRpc("set_locale", input) as Promise<unknown>,
      remember_project: (input) => harness.behavior.callRpc("remember_project", input) as Promise<unknown>,
      list_projects: () => ({ projects: [{ id: projectId, name: "Access fixture" }], lastProjectId: projectId }),
      list_sections: () => ({ sections: SECTIONS }),
      get_screen: (input) => harness.behavior.callRpc("get_screen", input) as Promise<unknown>,
      helper_access_view: (input) => { const call = input as { projectId: string; sectionId?: string }; views.push(call); return view(call.projectId, call.sectionId); },
      save_setting: (input) => {
        const call = input as SaveCall;
        saves.push(call);
        const own = ownRows(call.projectId, call.sectionId);
        const current = own[call.key]?.version ?? 0;
        if (call.expectedVersion !== current) return { ok: false, conflict: true, version: current, value: own[call.key]?.value ?? null };
        own[call.key] = { value: call.value, version: current + 1, present: true };
        return { ok: true, conflict: false, version: current + 1, value: call.value };
      },
      reset_project_settings: (input) => {
        const call = input as ResetCall;
        resets.push(call);
        const own = ownRows(call.projectId, call.sectionId);
        for (const key of call.keys) own[key] = { value: null, version: (own[key]?.version ?? 0) + 1, present: false };
        return { ok: true, conflict: false, values: {}, versions: {} };
      },
    },
  });
  return { harness, slot, saves, resets, views, setMode: (next: string) => { mode = next; } };
}

async function openAccessTab(slot: RenderedSlot) {
  fireEvent.mouseDown(await slot.findByTestId("tab-access"), { button: 0 });
  await slot.findByTestId("access-role-writer");
}

async function choose(slot: RenderedSlot, testId: string, label: string) {
  fireEvent.keyDown(slot.getByTestId(testId), { key: "Enter" });
  fireEvent.click(await slot.findByRole("option", { name: label }));
}

afterEach(() => { cleanup(); setLocaleOverride(null); document.documentElement.lang = "en"; });

describe("Agent access tab", () => {
  it("names every helper role in both languages", () => {
    for (const role of HELPER_ROLES) {
      const id = role.replace(/[:-]/g, "_");
      for (const dict of [en, ru] as Array<Record<string, string>>) {
        expect(dict[`accessName_${id}`], role).toBeTruthy();
        expect(dict[`accessPurpose_${id}`], role).toBeTruthy();
      }
    }
  });

  it("lists every role with its summary and badge, shows rows when expanded, and keeps the mandatory chips locked", async () => {
    const { slot, harness } = await mount();
    try {
      await openAccessTab(slot);
      for (const role of HELPER_ROLES) expect(slot.getByTestId(`access-role-${role.replace(/[:-]/g, "_")}`)).toBeTruthy();
      expect(slot.getByTestId("access-summary-writer").textContent).toBe("2 skills · 2 MCP");
      expect(slot.getByTestId("access-summary-plan_critic").textContent).toBe("1 MCP");
      expect(slot.getByTestId("access-summary-browser_qa").textContent).toBe("1 skill · 1 BB plugin");
      expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessOrigin_role);
      expect(slot.getByTestId("access-providers").textContent).toContain("Claude Code and Codex: everything.");
      expect(slot.getByTestId("access-providers").textContent).toContain("OpenCode: everything except CLI plugins.");
      expect(slot.getByTestId("access-providers").textContent).toContain("Grok (Cursor): everything except CLI plugins; Cursor's own skills cannot be turned off; project instructions cannot be turned off.");
      expect(slot.queryByTestId("access-writer-skills")).toBeNull();
      fireEvent.click(within(slot.getByTestId("access-role-writer")).getByRole("button", { expanded: false }));
      for (const group of ["bbPlugins", "skills", "mcpServers", "nativePlugins", "userInstructions", "projectInstructions"]) expect(slot.getByTestId(`access-writer-${group}`)).toBeTruthy();
      expect(slot.getByTestId("access-writer-skills-effective").textContent).toBe("writer-practices, karpathy-guidelines · role default");
      expect(slot.getByTestId("access-writer-bbPlugins-effective").textContent).toBe("environment-project-checkout, project-folders · role default");
      expect(slot.getByTestId("access-writer-nativePlugins-effective").textContent).toBe("none · role default");
      expect(slot.getByTestId("access-writer-userInstructions-effective").textContent).toBe("left out · role default");
      expect(slot.getByTestId("access-writer-projectInstructions-effective").textContent).toBe("included · role default");
      expect(slot.queryByRole("button", { name: en.accessResetTo_role })).toBeNull();
      expect(slot.queryByTestId("access-mode-off")).toBeNull();
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

  it("saves «Only selected» plus an added skill with the role key and version, then resets by dropping the row", async () => {
    const { slot, harness, saves, resets } = await mount();
    try {
      await openAccessTab(slot);
      fireEvent.click(within(slot.getByTestId("access-role-writer")).getByRole("button", { expanded: false }));
      await choose(slot, "access-writer-skills-mode", en.accessModeAllow);
      await waitFor(() => expect(saves).toHaveLength(1));
      expect(saves[0]).toEqual({ projectId, key: "helper.access.writer", expectedVersion: 0, value: { skills: { mode: "allow", names: ["writer-practices", "karpathy-guidelines"] } } });
      const editor = await slot.findByTestId("access-writer-skills-editor");
      expect(within(editor).getAllByText("writer-practices").length).toBe(1);
      expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessOrigin_project);
      const search = within(editor).getByLabelText(en.accessAddSearchSkills);
      fireEvent.focus(search);
      fireEvent.change(search, { target: { value: "ru-" } });
      const option = await within(editor).findByRole("option", { name: /ru-text/ });
      expect(option.getAttribute("title")).toBe("Russian text quality");
      fireEvent.click(option);
      await waitFor(() => expect(saves).toHaveLength(2));
      expect(saves[1]).toEqual({ projectId, key: "helper.access.writer", expectedVersion: 1, value: { skills: { mode: "allow", names: ["writer-practices", "karpathy-guidelines", "ru-text"] } } });
      await waitFor(() => expect(slot.getByTestId("access-summary-writer").textContent).toBe("3 skills · 2 MCP"));
      expect(slot.getByTestId("access-writer-skills-effective").textContent).toBe("writer-practices, karpathy-guidelines, ru-text · project");
      // The always-on BB plugins stay as locked chips and cannot be removed.
      await choose(slot, "access-writer-bbPlugins-mode", en.accessModeAllow);
      await waitFor(() => expect(saves).toHaveLength(3));
      expect(saves[2]!.value).toEqual({ skills: { mode: "allow", names: ["writer-practices", "karpathy-guidelines", "ru-text"] }, bbPlugins: { mode: "allow", names: [] } });
      const plugins = await slot.findByTestId("access-writer-bbPlugins-editor");
      expect(plugins.querySelectorAll("[data-chip=locked]")).toHaveLength(2);
      expect(within(plugins).queryByRole("button", { name: /Remove/ })).toBeNull();
      // Personal instructions use their own switch values.
      await choose(slot, "access-writer-userInstructions-mode", en.accessInclude);
      await waitFor(() => expect(saves).toHaveLength(4));
      expect((saves[3]!.value as Record<string, unknown>).userInstructions).toBe("include");
      // Reset drops this level's row (a stored null would hide the level below) and falls back to the role profile.
      fireEvent.click(await slot.findByRole("button", { name: en.accessResetTo_role }));
      await waitFor(() => expect(resets).toHaveLength(1));
      expect(saves).toHaveLength(4);
      expect(resets[0]).toEqual({ projectId, keys: ["helper.access.writer"], expectedVersions: { "helper.access.writer": 4 } });
      await waitFor(() => expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessOrigin_role));
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  }, 45_000); // jsdom clicks through two menus; under a full parallel run it took 16 s and timed out

  it("takes free-text names for MCP servers and removes a chip", async () => {
    const { slot, harness, saves } = await mount();
    try {
      await openAccessTab(slot);
      fireEvent.click(within(slot.getByTestId("access-role-docs_maintainer")).getByRole("button", { expanded: false }));
      await choose(slot, "access-docs_maintainer-mcpServers-mode", en.accessModeAllow);
      const editor = await slot.findByTestId("access-docs_maintainer-mcpServers-editor");
      const input = within(editor).getByLabelText(en.accessAddTypeName);
      fireEvent.change(input, { target: { value: "context7" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(saves.at(-1)?.value).toEqual({ mcpServers: { mode: "allow", names: ["gitnexus", "context7"] } }));
      fireEvent.click(await within(editor).findByRole("button", { name: `${en.accessRemove}: context7` }));
      await waitFor(() => expect(saves.at(-1)?.value).toEqual({ mcpServers: { mode: "allow", names: ["gitnexus"] } }));
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

  it("says the per-role settings do not apply when the session filter is not «By role»", async () => {
    const { slot, harness } = await mount({ mode: "inherit" });
    try {
      await openAccessTab(slot);
      expect(slot.getByTestId("access-mode-off").textContent).toBe(en.accessModeOff);
      expect(slot.getByTestId("access-mode-fields").querySelector("[data-storage-key='helper.context_mode']")).toBeTruthy();
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

  it("shows a summary matrix with counts, «all», dashes and origins, and a row opens and scrolls to its card", async () => {
    const { slot, harness } = await mount({ preset: { project: { skills: { mode: "allow", names: ["ru-text"] }, bbPlugins: { mode: "all" }, userInstructions: "include" } } });
    try {
      await openAccessTab(slot);
      const matrix = slot.getByTestId("access-matrix");
      expect(matrix.querySelectorAll("tbody tr[data-testid^=access-matrix-row-]")).toHaveLength(HELPER_ROLES.length);
      const cell = (role: string, column: string) => slot.getByTestId(`access-matrix-${role}-${column}`).textContent;
      expect([cell("browser_qa", "skills"), cell("browser_qa", "bbPlugins"), cell("browser_qa", "mcpServers"), cell("browser_qa", "projectInstructions")]).toEqual(["1", "1", "—", "✓"]);
      expect([cell("plan_critic", "skills"), cell("plan_critic", "userInstructions")]).toEqual(["—", "—"]);
      expect([cell("docs_maintainer", "skills"), cell("specialist_seo_specialist", "skills")]).toEqual(["2", "17"]);
      // A change at this level: «all» for everything BB has, the changed count, the personal switch on.
      expect([cell("writer", "bbPlugins"), cell("writer", "skills"), cell("writer", "userInstructions")]).toEqual([en.accessAllShort, "1", "✓"]);
      expect(slot.getByTestId("access-matrix-origin-writer").textContent).toBe(en.accessOrigin_project);
      expect(slot.getByTestId("access-matrix-origin-code_critic").textContent).toBe(en.accessOrigin_role);
      // The table scrolls inside its own box, so the page itself never gets wider.
      expect(slot.getByTestId("access-matrix-scroll").className).toContain("overflow-x-auto");
      const scrolled = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");
      expect(slot.getByTestId("access-role-docs_maintainer").getAttribute("data-open")).toBe("false");
      fireEvent.click(within(slot.getByTestId("access-matrix-row-docs_maintainer")).getByRole("button"));
      await waitFor(() => expect(slot.getByTestId("access-role-docs_maintainer").getAttribute("data-open")).toBe("true"));
      await waitFor(() => expect(scrolled.mock.contexts.some((node) => (node as HTMLElement).id === "access-card-docs_maintainer")).toBe(true));
      scrolled.mockRestore();
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

  it("shows the main agent (PM) as an information card without controls", async () => {
    const { slot, harness } = await mount();
    try {
      await openAccessTab(slot);
      const card = slot.getByTestId("access-pm-card");
      expect(card.textContent).toContain(en.accessPmTitle);
      expect(card.textContent).toContain(en.accessPmBody);
      expect(card.textContent).toContain(en.accessPmNarrow);
      expect(card.querySelectorAll("button, select, input, [role=combobox]")).toHaveLength(0);
      // It comes before the first group of helpers.
      expect(card.compareDocumentPosition(slot.getByTestId("access-section-code")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

  it("edits the global defaults with projectId «*», and a project shows them as «global», overrides them and falls back to global", async () => {
    const { slot, harness, saves, resets } = await mount({ modeOrigin: "global" });
    try {
      fireEvent.click(await slot.findByRole("tab", { name: en.navGlobals }));
      await openAccessTab(slot);
      expect(slot.getByTestId("agent-access").getAttribute("data-scope")).toBe("global");
      expect(slot.getByTestId("access-scope-note").textContent).toBe(en.accessIntroGlobal);
      expect(slot.getByTestId("access-mode-origin").textContent).toContain(en.accessOrigin_global);
      fireEvent.click(within(slot.getByTestId("access-role-writer")).getByRole("button", { expanded: false }));
      expect(slot.queryByRole("button", { name: en.accessResetTo_role })).toBeNull();
      await choose(slot, "access-writer-skills-mode", en.accessModeAllow);
      await waitFor(() => expect(saves).toHaveLength(1));
      expect(saves[0]).toEqual({ projectId: "*", key: "helper.access.writer", expectedVersion: 0, value: { skills: { mode: "allow", names: ["writer-practices", "karpathy-guidelines"] } } });
      await waitFor(() => expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessOrigin_global));
      expect(slot.getByTestId("access-writer-skills-origin").textContent).toBe(en.accessOrigin_global);
      expect(slot.getByTestId("access-writer-bbPlugins-origin").textContent).toBe(en.accessOrigin_role);
      // In the project the same change shows as «global», with the order of the levels spelled out.
      fireEvent.click(slot.getByTestId(`project-item-${projectId}`));
      await waitFor(() => expect(slot.getByTestId("agent-access").getAttribute("data-scope")).toBe("project"));
      expect(slot.getByTestId("access-scope-note").textContent).toBe(en.accessOrder);
      await waitFor(() => expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessOrigin_global));
      expect(slot.getByTestId("access-matrix-origin-writer").textContent).toBe(en.accessOrigin_global);
      fireEvent.click(within(slot.getByTestId("access-role-writer")).getByRole("button", { expanded: false }));
      expect(slot.queryByRole("button", { name: /^Back to/ })).toBeNull();
      // Overriding in the project keeps what the global level changed for the other groups and takes over the whole role.
      await choose(slot, "access-writer-userInstructions-mode", en.accessInclude);
      await waitFor(() => expect(saves).toHaveLength(2));
      expect(saves[1]).toEqual({ projectId, key: "helper.access.writer", expectedVersion: 0, value: { skills: { mode: "allow", names: ["writer-practices", "karpathy-guidelines"] }, userInstructions: "include" } });
      await waitFor(() => expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessOrigin_project));
      expect(slot.getByTestId("access-writer-userInstructions-origin").textContent).toBe(en.accessOrigin_project);
      fireEvent.click(await slot.findByRole("button", { name: en.accessResetTo_global }));
      await waitFor(() => expect(resets).toHaveLength(1));
      expect(resets[0]).toEqual({ projectId, keys: ["helper.access.writer"], expectedVersions: { "helper.access.writer": 1 } });
      await waitFor(() => expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessOrigin_global));
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  }, 45_000); // jsdom re-renders the long role cards at every step; a loaded Linux run exceeded the 15 s default

  it("in a section names the level below: the parent section, the project, global or the role profile", async () => {
    const { slot, harness, resets, views } = await mount({ preset: { sec_a: { skills: { mode: "all" } }, sec_b: { userInstructions: "include" } } });
    try {
      fireEvent.click(await slot.findByTestId("tab-access", {}, { timeout: 5000 }).then((tab) => { fireEvent.mouseDown(tab, { button: 0 }); return slot.getByTestId(`project-item-${projectId}`); }));
      fireEvent.click(await slot.findByTestId("section-item-sec_b"));
      await waitFor(() => expect(slot.getByTestId("agent-access").getAttribute("data-scope")).toBe("section"));
      // The nested section asks for its own view and for its parent's.
      await waitFor(() => expect(views).toContainEqual({ projectId, sectionId: "sec_b" }));
      expect(views).toContainEqual({ projectId, sectionId: "sec_a" });
      await waitFor(() => expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessOrigin_section));
      fireEvent.click(within(slot.getByTestId("access-role-writer")).getByRole("button", { expanded: false }));
      fireEvent.click(await slot.findByRole("button", { name: en.accessResetTo_section }));
      await waitFor(() => expect(resets).toHaveLength(1));
      expect(resets[0]).toEqual({ projectId, sectionId: "sec_b", keys: ["helper.access.writer"], expectedVersions: { "helper.access.writer": 1 } });
      // Without a row of its own the section shows the parent section's change, and offers no reset.
      await waitFor(() => expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessOrigin_section));
      expect(slot.getByTestId("access-writer-skills-origin").textContent).toBe(en.accessOrigin_section);
      expect(slot.queryByRole("button", { name: /^Back to/ })).toBeNull();
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

  it("the real backend accepts the values the tab sends at the global and project levels and drops a row on reset", async () => {
    const { slot, harness } = await mount();
    try {
      const call = (method: string, input: unknown) => harness.behavior.callRpc(method as never, input as never) as Promise<any>;
      const value = { skills: { mode: "allow", names: ["ru-text"] }, userInstructions: "include" };
      expect((await call("save_setting", { projectId: "*", key: "helper.access.writer", value, expectedVersion: 0 })).ok).toBe(true);
      let view = await call("helper_access_view", { projectId });
      let writer = view.roles.find((role: { role: string }) => role.role === "writer");
      expect(writer.origin).toBe("global");
      expect(writer.groups.skills).toEqual({ names: ["ru-text"], source: "owner" });
      const own = { skills: { mode: "all" } };
      expect((await call("save_setting", { projectId, key: "helper.access.writer", value: own, expectedVersion: 0 })).ok).toBe(true);
      view = await call("helper_access_view", { projectId });
      writer = view.roles.find((role: { role: string }) => role.role === "writer");
      expect(writer).toMatchObject({ origin: "project", version: 1, groups: { skills: { names: null, source: "owner" } }, switches: { userInstructions: { include: false, source: "role" } } });
      const reset = await call("reset_project_settings", { projectId, keys: ["helper.access.writer"], expectedVersions: { "helper.access.writer": 1 } });
      expect(reset.ok).toBe(true);
      view = await call("helper_access_view", { projectId });
      writer = view.roles.find((role: { role: string }) => role.role === "writer");
      expect(writer.origin).toBe("global");
      expect(writer.groups.skills.names).toEqual(["ru-text"]);
      const globalReset = await call("reset_project_settings", { projectId: "*", keys: ["helper.access.writer"], expectedVersions: { "helper.access.writer": 1 } });
      expect(globalReset.ok).toBe(true);
      view = await call("helper_access_view", { projectId: "*" });
      expect(view.roles.find((role: { role: string }) => role.role === "writer").origin).toBeNull();
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });
});
