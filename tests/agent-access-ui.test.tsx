/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { installTestPluginRuntime, loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { openDatabase, savePrototypeConfig } from "../src/database";
import { ACCESS_GROUPS, ACCESS_SWITCHES, HELPER_ROLES, MANDATORY_BB_PLUGINS, MANDATORY_MCP_SERVERS, CORE_PROVIDER_GROUPS, effectiveGroup, effectiveSwitch, parseRoleAccess, roleAccessKey } from "../src/helper-context";
import { en, ru, setLocaleOverride } from "../i18n";
import plugin from "../server";

vi.setConfig({ testTimeout: 15_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const projectId = "proj_access_ui";

type SaveCall = { projectId: string; sectionId?: string; key: string; value: unknown; expectedVersion: number };

async function mount(options: { mode?: string } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { plugins: { list: async () => [] }, skills: { list: async () => [] }, projects: { get: async ({ projectId: id }) => ({ id, name: id, sources: [{ hostId: "h", path: "/tmp/access-ui", isDefault: true }] }), list: async () => [] } },
  });
  savePrototypeConfig(openDatabase(bb), { projectId, hostId: "h", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/access-ui", pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "g" });
  await plugin(bb);
  installTestPluginRuntime();
  const store: Record<string, { value: unknown; version: number }> = {};
  const saves: SaveCall[] = [];
  let mode = options.mode ?? "roles";
  const view = () => ({
    mode,
    roles: HELPER_ROLES.map((role) => {
      const key = roleAccessKey(role);
      const access = parseRoleAccess(store[key]?.value);
      return {
        role, key, version: store[key]?.version ?? 0, value: store[key]?.value ?? null, inherited: false,
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
  });
  const app = await loadPluginApp(await import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    context: { projectId, threadId: null },
    providers: { status: "ready", providers: [] as never },
    rpc: {
      get_preferences: (input) => harness.behavior.callRpc("get_preferences", input) as Promise<unknown>,
      set_locale: (input) => harness.behavior.callRpc("set_locale", input) as Promise<unknown>,
      remember_project: (input) => harness.behavior.callRpc("remember_project", input) as Promise<unknown>,
      list_projects: () => ({ projects: [{ id: projectId, name: "Access fixture" }], lastProjectId: projectId }),
      get_screen: (input) => harness.behavior.callRpc("get_screen", input) as Promise<unknown>,
      helper_access_view: () => view(),
      save_setting: (input) => {
        const call = input as SaveCall;
        saves.push(call);
        const current = store[call.key]?.version ?? 0;
        if (call.expectedVersion !== current) return { ok: false, conflict: true, version: current, value: store[call.key]?.value ?? null };
        store[call.key] = { value: call.value, version: current + 1 };
        return { ok: true, conflict: false, version: current + 1, value: call.value };
      },
    },
  });
  return { harness, slot, saves, setMode: (next: string) => { mode = next; } };
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
      expect(slot.getByTestId("access-summary-writer").textContent).toBe("2 skills");
      expect(slot.getByTestId("access-summary-plan_critic").textContent).toBe(en.accessNothingExtra);
      expect(slot.getByTestId("access-summary-browser_qa").textContent).toBe("2 skills · 1 BB plugin");
      expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessSourceRole);
      expect(slot.getByTestId("access-providers").textContent).toContain("Claude Code and Codex: everything.");
      expect(slot.getByTestId("access-providers").textContent).toContain("OpenCode: everything except CLI plugins.");
      expect(slot.getByTestId("access-providers").textContent).toContain("Grok (Cursor): everything except CLI plugins; Cursor's own skills cannot be turned off; project instructions cannot be turned off.");
      expect(slot.queryByTestId("access-writer-skills")).toBeNull();
      fireEvent.click(within(slot.getByTestId("access-role-writer")).getByRole("button", { expanded: false }));
      for (const group of ["bbPlugins", "skills", "mcpServers", "nativePlugins", "userInstructions", "projectInstructions"]) expect(slot.getByTestId(`access-writer-${group}`)).toBeTruthy();
      expect(slot.getByTestId("access-writer-skills-effective").textContent).toBe("writer-practices, karpathy-guidelines · by role");
      expect(slot.getByTestId("access-writer-bbPlugins-effective").textContent).toBe("environment-project-checkout, project-folders · by role");
      expect(slot.getByTestId("access-writer-nativePlugins-effective").textContent).toBe("none · by role");
      expect(slot.getByTestId("access-writer-userInstructions-effective").textContent).toBe("left out · by role");
      expect(slot.getByTestId("access-writer-projectInstructions-effective").textContent).toBe("included · by role");
      expect(slot.queryByRole("button", { name: en.accessReset })).toBeNull();
      expect(slot.queryByTestId("access-mode-off")).toBeNull();
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

  it("saves «Only selected» plus an added skill with the role key and version, then resets with null", async () => {
    const { slot, harness, saves } = await mount();
    try {
      await openAccessTab(slot);
      fireEvent.click(within(slot.getByTestId("access-role-writer")).getByRole("button", { expanded: false }));
      await choose(slot, "access-writer-skills-mode", en.accessModeAllow);
      await waitFor(() => expect(saves).toHaveLength(1));
      expect(saves[0]).toEqual({ projectId, key: "helper.access.writer", expectedVersion: 0, value: { skills: { mode: "allow", names: ["writer-practices", "karpathy-guidelines"] } } });
      const editor = await slot.findByTestId("access-writer-skills-editor");
      expect(within(editor).getAllByText("writer-practices").length).toBe(1);
      expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessSourceOwner);
      const search = within(editor).getByLabelText(en.accessAddSearchSkills);
      fireEvent.focus(search);
      fireEvent.change(search, { target: { value: "ru-" } });
      const option = await within(editor).findByRole("option", { name: /ru-text/ });
      expect(option.getAttribute("title")).toBe("Russian text quality");
      fireEvent.click(option);
      await waitFor(() => expect(saves).toHaveLength(2));
      expect(saves[1]).toEqual({ projectId, key: "helper.access.writer", expectedVersion: 1, value: { skills: { mode: "allow", names: ["writer-practices", "karpathy-guidelines", "ru-text"] } } });
      await waitFor(() => expect(slot.getByTestId("access-summary-writer").textContent).toBe("3 skills"));
      expect(slot.getByTestId("access-writer-skills-effective").textContent).toBe("writer-practices, karpathy-guidelines, ru-text · changed");
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
      fireEvent.click(await slot.findByRole("button", { name: en.accessReset }));
      await waitFor(() => expect(saves).toHaveLength(5));
      expect(saves[4]).toEqual({ projectId, key: "helper.access.writer", expectedVersion: 4, value: null });
      await waitFor(() => expect(slot.getByTestId("access-badge-writer").textContent).toBe(en.accessSourceRole));
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

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
      await waitFor(() => expect(saves.at(-1)?.value).toEqual({ mcpServers: { mode: "allow", names: ["context7"] } }));
      fireEvent.click(await within(editor).findByRole("button", { name: `${en.accessRemove}: context7` }));
      await waitFor(() => expect(saves.at(-1)?.value).toEqual({ mcpServers: { mode: "allow", names: [] } }));
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

  it("the real backend accepts the value the tab sends and reports it back as the owner's change", async () => {
    const { slot, harness } = await mount();
    try {
      const value = { skills: { mode: "allow", names: ["ru-text"] }, userInstructions: "include" };
      const saved = await harness.behavior.callRpc("save_setting", { projectId, key: "helper.access.writer", value, expectedVersion: 0 }) as { ok: boolean };
      expect(saved.ok).toBe(true);
      const view = await harness.behavior.callRpc("helper_access_view", { projectId }) as { roles: Array<{ role: string; version: number; groups: { skills: { names: string[]; source: string } }; switches: { userInstructions: { include: boolean; source: string } } }> };
      const writer = view.roles.find((role) => role.role === "writer")!;
      expect(writer.version).toBe(1);
      expect(writer.groups.skills).toEqual({ names: ["ru-text"], source: "owner" });
      expect(writer.switches.userInstructions).toEqual({ include: true, source: "owner" });
      const reset = await harness.behavior.callRpc("save_setting", { projectId, key: "helper.access.writer", value: null, expectedVersion: 1 }) as { ok: boolean };
      expect(reset.ok).toBe(true);
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });
});
