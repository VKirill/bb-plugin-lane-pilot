import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ROLE_TABLE, roleModelKey } from "@lane-pilot/models";
import { getSettingVersions, listSettingRows, openDatabase, saveProjectSetting, sectionBindingId } from "../src/rooms/storage/database";
import { isModelSettingKey } from "../src/rooms/settings/model-keys";
import plugin from "../server";

const GLOBAL = "*";
type Roles = { roles: Array<{ role: string; model: string; providerId: string; effort: string; source: string; sourceKey: string | null; own: boolean; version: number; offered: boolean | null; defaultModel: string }>; options: Array<{ id: string; offered: boolean | null; efforts: string[] }> };

const info = (id: string) => ({ id, displayName: id, available: true, logoUrl: null, capabilities: { supportsServiceTier: false } });
const model = (id: string, efforts: string[]) => ({ id, model: id, displayName: id, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })), defaultReasoningEffort: efforts[0], isDefault: false });

async function mount(withCatalog = false) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      plugins: { list: async () => [], callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
        if (pluginId === "project-folders" && method === "sections_list") return { sections: [
          { id: "s1", projectId: "p1", parentId: null, name: "Docs", path: "/work/docs", hostId: "h", kind: "folder" },
          { id: "s2", projectId: "p1", parentId: "s1", name: "Api", path: "/work/docs/api", hostId: "h", kind: "folder" },
        ] };
        throw new Error(`unexpected rpc ${pluginId}.${method}`);
      } },
      projects: { get: async ({ projectId }) => ({ id: projectId, name: projectId, sources: [] }), list: async () => [{ id: "p1", name: "Alpha", kind: "standard" }] as never },
      ...(withCatalog ? {
        hosts: { list: async () => [{ id: "mac", name: "Mac mini", status: "connected" }] },
        providers: {
          list: async () => [info("claude-code"), info("codex"), info("opencode2")],
          models: async (args?: { providerId?: string }) => { const providerId = args?.providerId; if (providerId === "opencode2") return { models: [model("router9/ag/gemini-3.8-flash-high", ["medium", "high"])] }; return { models: providerId === "claude-code" ? [model("claude-opus-5-5", ["low", "high", "max"]), model("claude-sonnet-5-5", ["low", "medium"])] : [model("gpt-6.1-sol", ["medium", "high"])] }; },
        },
      } : {}),
    },
  });
  const db = openDatabase(bb);
  await plugin(bb);
  return { db, harness };
}

const read = (harness: Awaited<ReturnType<typeof mount>>["harness"], input: Record<string, unknown>) => harness.behavior.callRpc("get_role_models", input) as Promise<Roles>;

describe("get_role_models: the table «role -> model» of a place", () => {
  it("lists every role of the table on its built-in default when nothing is set", async () => {
    const { harness } = await mount();
    const got = await read(harness, { projectId: GLOBAL });
    expect(got.roles.map((row) => row.role)).toEqual(ROLE_TABLE.map((row) => row.id));
    for (const row of got.roles) expect(row, row.role).toMatchObject({ source: "default", sourceKey: null, own: false, version: 0, offered: null, model: row.defaultModel });
    expect(got.roles.find((row) => row.role === "code-critic")).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", effort: "medium" });
    expect(got.roles.find((row) => row.role === "auditor")).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", effort: "high" });
    expect(got.options.map((option) => option.id)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna", "router9/ag/gemini-3.8-flash-high", "glm-5.3-flash"]);
    expect(got.options.find((option) => option.id === "router9/ag/gemini-3.8-flash-high")).toMatchObject({ providerId: "opencode2", family: "google", label: "Gemini 3.8 Flash (9router)" });
    await harness.lifecycle.dispose();
  });

  it("a row is saved through save_setting and refused when it is not a pick of the table", async () => {
    const { db, harness } = await mount();
    const key = roleModelKey("analyst");
    for (const value of [{ model: "claude-sonnet-5-5", reasoning_effort: "medium" }, { model: "gpt-6.1-terra" }]) {
      const saved = await harness.behavior.callRpc("save_setting", { projectId: GLOBAL, key, value, expectedVersion: getSettingVersions(db, GLOBAL, [key])[key] }) as { ok: boolean };
      expect(saved.ok, JSON.stringify(value)).toBe(true);
    }
    for (const value of [{ model: "zai/glm-5.3-flash" }, { model: "claude-opus-5-5", provider: "codex" }, { model: "claude-opus-5-5", reasoning_effort: "ultra" }, "claude-opus-5-5"]) {
      const refused = await harness.behavior.callRpc("save_setting", { projectId: GLOBAL, key, value, expectedVersion: getSettingVersions(db, GLOBAL, [key])[key] }) as { ok: boolean; validation?: { code: string; key: string } };
      expect(refused, JSON.stringify(value)).toMatchObject({ ok: false, validation: { code: "invalid_choice", key } });
    }
    expect(listSettingRows(db, GLOBAL).find((row) => row.key === key)!.value).toEqual({ model: "gpt-6.1-terra" });
    await harness.lifecycle.dispose();
  });

  it("a project and a section keep their own row over the global one; `own` and `version` belong to the place shown", async () => {
    const { db, harness } = await mount();
    saveProjectSetting(db, GLOBAL, roleModelKey("planner"), { model: "claude-sonnet-5-5" });
    saveProjectSetting(db, GLOBAL, roleModelKey("debugger"), { model: "claude-opus-5-5", reasoning_effort: "max" });
    saveProjectSetting(db, "p1", roleModelKey("planner"), { model: "gpt-6.1-sol", reasoning_effort: "low" });
    const row = (got: Roles, role: string) => got.roles.find((item) => item.role === role)!;
    const global = await read(harness, { projectId: GLOBAL });
    expect(row(global, "planner")).toMatchObject({ model: "claude-sonnet-5-5", source: "table", sourceKey: "role_model.planner", own: true, version: 1 });
    const project = await read(harness, { projectId: "p1" });
    expect(row(project, "planner")).toMatchObject({ model: "gpt-6.1-sol", providerId: "codex", effort: "low", source: "table", own: true, version: 1 });
    // The global debugger row shows through in the project, and is not the project's own.
    expect(row(project, "debugger")).toMatchObject({ model: "claude-opus-5-5", effort: "max", source: "table", own: false, version: 0 });
    // A section of the project that holds nothing of its own sees the project's row; one with a row of its own sees that.
    const bindingId = sectionBindingId("s1");
    const section = await read(harness, { projectId: "p1", sectionId: "s1" });
    expect(row(section, "planner")).toMatchObject({ model: "gpt-6.1-sol", own: false });
    await harness.behavior.callRpc("save_setting", { projectId: "p1", sectionId: "s1", key: roleModelKey("planner"), value: { model: "claude-haiku-5-5" }, expectedVersion: 0 });
    expect(listSettingRows(db, "p1", bindingId).map((item) => item.key)).toEqual([roleModelKey("planner")]);
    expect(row(await read(harness, { projectId: "p1", sectionId: "s1" }), "planner")).toMatchObject({ model: "claude-haiku-5-5", own: true });
    expect(row(await read(harness, { projectId: "p1" }), "planner")).toMatchObject({ model: "gpt-6.1-sol" });
    // A section below it takes the section's row, not its own.
    expect(row(await read(harness, { projectId: "p1", sectionId: "s2" }), "planner")).toMatchObject({ model: "claude-haiku-5-5", own: false });
    await harness.lifecycle.dispose();
  });

  it("carries a stage selection made before the table into the role it served, and the table's own row wins over it", async () => {
    const { db, harness } = await mount();
    for (const [key, value] of Object.entries({ "plan_critique.provider": "claude-code", "plan_critique.model": "claude-opus-5-5", "plan_critique.reasoning_effort": "xhigh", "pm_read.provider": "codex", "pm_read.model": "gpt-6-luna", "specialist.provider": "claude-code", "specialist.model": "claude-sonnet-5-5" })) saveProjectSetting(db, GLOBAL, key, value);
    const row = (got: Roles, role: string) => got.roles.find((item) => item.role === role)!;
    const got = await read(harness, { projectId: GLOBAL });
    expect(row(got, "plan-critic")).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh", source: "stage", sourceKey: "plan_critique.model", own: false });
    expect(row(got, "pm-reader")).toMatchObject({ model: "gpt-6-luna", source: "stage", sourceKey: "pm_read.model" });
    expect(row(got, "specialist")).toMatchObject({ model: "claude-sonnet-5-5", source: "stage" });
    expect(row(got, "specialist-reviewer")).toMatchObject({ model: "claude-sonnet-5-5", source: "stage" });
    // The analyst and the planner borrow no stage.
    expect(row(got, "analyst")).toMatchObject({ source: "default" });
    saveProjectSetting(db, GLOBAL, roleModelKey("plan-critic"), { model: "gpt-6.1-sol" });
    expect(row(await read(harness, { projectId: GLOBAL }), "plan-critic")).toMatchObject({ model: "gpt-6.1-sol", source: "table", own: true });
    await harness.lifecycle.dispose();
  });

  it("says which of the options the machines offer, and the efforts of each", async () => {
    const { harness } = await mount(true);
    const got = await read(harness, { projectId: GLOBAL });
    expect(got.options.map((option) => [option.id, option.offered])).toEqual([
      ["claude-fable-5-1", false], ["claude-opus-5-5", true], ["claude-sonnet-5-5", true], ["claude-haiku-5-5", false], ["gpt-6.1-sol", true], ["gpt-6.1-terra", false], ["gpt-6-astra", false], ["gpt-6-luna", false], ["router9/ag/gemini-3.8-flash-high", true], ["glm-5.3-flash", false],
    ]);
    expect(got.options.find((option) => option.id === "router9/ag/gemini-3.8-flash-high")!.efforts).toEqual(["medium", "high"]);
    // The reviews' default is on offer here; a row that holds the Gemini says so, and the plan critic shows it.
    expect(got.roles.find((row) => row.role === "plan-critic")).toMatchObject({ model: "router9/ag/gemini-3.8-flash-high", effort: "medium", offered: true });
    expect(got.options.find((option) => option.id === "claude-opus-5-5")!.efforts).toEqual(["low", "high", "max"]);
    expect(got.options.find((option) => option.id === "gpt-6.1-sol")!.efforts).toEqual(["medium", "high"]);
    expect(got.roles.find((row) => row.role === "pm-reader")).toMatchObject({ model: "claude-haiku-5-5", offered: false });
    expect(got.roles.find((row) => row.role === "planner")).toMatchObject({ model: "claude-opus-5-5", offered: true });
    await harness.lifecycle.dispose();
  });

  it("is part of the models a project may keep for itself: «give everyone the global models back» takes the role rows with it", async () => {
    expect(isModelSettingKey(roleModelKey("analyst"))).toBe(true);
    expect(isModelSettingKey("role_model.nobody")).toBe(true);
    expect(isModelSettingKey("role_models")).toBe(false);
    const { db, harness } = await mount();
    saveProjectSetting(db, "p1", roleModelKey("analyst"), { model: "claude-haiku-5-5" });
    saveProjectSetting(db, "p1", "night_review.enabled", true);
    const listed = await harness.behavior.callRpc("list_model_overrides", {}) as { levels: Array<{ projectId: string; sectionId: string | null; keys: string[] }> };
    expect(listed.levels).toEqual([expect.objectContaining({ projectId: "p1", keys: [roleModelKey("analyst")] })]);
    await harness.behavior.callRpc("reset_model_overrides", { levels: listed.levels.map(({ projectId, sectionId }) => ({ projectId, sectionId })) });
    expect(listSettingRows(db, "p1").map((row) => row.key)).toEqual(["night_review.enabled"]);
    await harness.lifecycle.dispose();
  });
});
