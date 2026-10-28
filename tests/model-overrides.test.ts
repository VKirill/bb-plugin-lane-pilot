import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { casUpsertSettings, getSettingVersions, listSettingRows, loadProjectSettings, openDatabase, saveProjectSetting, sectionBindingId } from "../src/rooms/storage/database";
import { isModelSettingKey, isRoleOverrideKey } from "../src/rooms/settings/model-keys";
import { PICKER_KEYS } from "../src/rooms/ui-shell/ui/page-model";
import { writerFallbackKeys } from "../src/rooms/writer/writer-fallbacks";
import plugin from "../server";

const GLOBAL = "*";

async function mount() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { projects: {
      get: async ({ projectId }) => ({ id: projectId, name: projectId, sources: [] }),
      list: async () => [{ id: "p1", name: "Alpha", kind: "standard" }, { id: "p2", name: "Beta", kind: "standard" }, { id: "pb", name: "LP bench Alpha", kind: "standard" }] as never,
    } },
  });
  const db = openDatabase(bb);
  await plugin(bb);
  return { db, harness };
}

describe("the keys that name who works a role", () => {
  it("cover every picker of the roles table and the fallback chain, and nothing else", () => {
    for (const key of PICKER_KEYS) expect(isModelSettingKey(key), key).toBe(true);
    for (const slot of [1, 2, 3]) for (const key of Object.values(writerFallbackKeys(slot))) expect(isModelSettingKey(key), key).toBe(true);
    for (const key of ["browser_qa.provider", "browser_qa.model", "browser_qa.reasoning_effort"]) expect(isModelSettingKey(key), key).toBe(true);
    for (const key of ["writer.agent", "writer.lastResult", "writer.fallback4.provider", "jev.provider", "memory.enabled", "night_review.enabled", "browser_qa.enabled", "browser_qa.host_id", "helper.context_mode", "workflow.agent.model", "main.agent"]) {
      expect(isModelSettingKey(key), key).toBe(false);
    }
  });
});

describe("the keys the reset takes back", () => {
  it("are the model rows and every role's agent, and no switch", () => {
    for (const key of ["writer.model", "docs.provider", "main.agent", "writer.agent", "docs.agent", "night_review.agent"]) expect(isRoleOverrideKey(key), key).toBe(true);
    for (const key of ["night_review.enabled", "workflow.agent.model", "helper.context_mode", "integration.gate_command"]) expect(isRoleOverrideKey(key), key).toBe(false);
  });
});

describe("giving every project and section the global role models back", () => {
  async function seed() {
    const { db, harness } = await mount();
    saveProjectSetting(db, GLOBAL, "writer.provider", "codex");
    saveProjectSetting(db, GLOBAL, "writer.model", "gpt-6-luna");
    saveProjectSetting(db, GLOBAL, "docs.provider", "codex");
    saveProjectSetting(db, "p1", "writer.provider", "qwen");
    saveProjectSetting(db, "p1", "writer.model", "qwen-test");
    saveProjectSetting(db, "p1", "writer.fallback1.provider", "claude-code");
    saveProjectSetting(db, "p1", "writer.agent", "my-writer");
    saveProjectSetting(db, "p1", "night_review.enabled", true);
    saveProjectSetting(db, "p2", "writer.agent", "other-writer");
    casUpsertSettings(db, { projectId: "p1", bindingId: sectionBindingId("s1"), changes: [
      { key: "docs.provider", value: "qwen", expectedVersion: 0 },
      { key: "docs.model", value: "qwen-test", expectedVersion: 0 },
    ] }, { nativeWriterSelection: true });
    saveProjectSetting(db, "gone", "memory.model", "qwen-test"); // a project the host no longer lists
    saveProjectSetting(db, "pb", "writer.model", "gpt-6-luna"); // the bench pins its models on purpose
    return { db, harness };
  }

  it("a project and a section keep their own value over the global one", async () => {
    const { db, harness } = await seed();
    expect(loadProjectSettings(db, "p1")).toMatchObject({ "writer.provider": "qwen", "docs.provider": "codex" });
    expect(loadProjectSettings(db, "p1", [sectionBindingId("s1")])).toMatchObject({ "writer.provider": "qwen", "docs.provider": "qwen" });
    expect(loadProjectSettings(db, "p2")).toMatchObject({ "writer.provider": "codex" });
    await harness.lifecycle.dispose();
  });

  it("lists the projects and sections that have their own models, and only those", async () => {
    const { harness } = await seed();
    const listed = await harness.behavior.callRpc("list_model_overrides", {}) as { levels: Array<{ projectId: string; projectName: string | null; sectionId: string | null; keys: string[] }> };
    expect(listed.levels).toEqual([
      { projectId: "gone", projectName: null, sectionId: null, sectionName: null, keys: ["memory.model"] },
      { projectId: "p1", projectName: "Alpha", sectionId: null, sectionName: null, keys: ["writer.agent", "writer.fallback1.provider", "writer.model", "writer.provider"] },
      { projectId: "p1", projectName: "Alpha", sectionId: "s1", sectionName: null, keys: ["docs.model", "docs.provider"] },
      { projectId: "p2", projectName: "Beta", sectionId: null, sectionName: null, keys: ["writer.agent"] },
    ]);
    await harness.lifecycle.dispose();
  });

  it("removes only those model rows: the global level, other settings and other projects stay; the project then inherits", async () => {
    const { db, harness } = await seed();
    const listed = await harness.behavior.callRpc("list_model_overrides", {}) as { levels: Array<{ projectId: string; sectionId: string | null }> };
    const before = getSettingVersions(db, "p1", ["writer.provider"]);
    const done = await harness.behavior.callRpc("reset_model_overrides", { levels: listed.levels.map(({ projectId, sectionId }) => ({ projectId, sectionId })) }) as { ok: boolean; levels: number; removed: number };
    expect(done).toEqual({ ok: true, levels: 4, removed: 8 });
    expect((await harness.behavior.callRpc("list_model_overrides", {}) as { levels: unknown[] }).levels).toEqual([]);
    expect(listSettingRows(db, "p1").map((row) => row.key).sort()).toEqual(["night_review.enabled"]);
    expect(listSettingRows(db, "p2").map((row) => row.key)).toEqual([]);
    // Even when a caller names it, the bench keeps its pinned model.
    expect(await harness.behavior.callRpc("reset_model_overrides", { levels: [{ projectId: "pb", sectionId: null }] })).toMatchObject({ levels: 0, removed: 0 });
    expect(listSettingRows(db, "pb").map((row) => row.key)).toEqual(["writer.model"]);
    expect(listSettingRows(db, GLOBAL).map((row) => row.key).sort()).toEqual(["docs.provider", "writer.model", "writer.provider"]);
    expect(loadProjectSettings(db, "p1", [sectionBindingId("s1")])).toMatchObject({ "writer.provider": "codex", "writer.model": "gpt-6-luna", "docs.provider": "codex" });
    // A save that read the screen before the reset conflicts, as after the per-role reset.
    expect(getSettingVersions(db, "p1", ["writer.provider"])["writer.provider"]).toBe(before["writer.provider"]! + 1);
    const screen = await harness.behavior.callRpc("get_screen", { projectId: "p1" }) as { explicitKeys: string[]; inheritedKeys: string[]; values: Record<string, unknown> };
    expect(screen.explicitKeys).not.toContain("writer.provider");
    expect(screen.inheritedKeys).toContain("writer.provider");
    expect(screen.values["writer.provider"]).toBe("codex");
    await harness.lifecycle.dispose();
  });

  it("resets only the levels it is given, and never the global one", async () => {
    const { db, harness } = await seed();
    const done = await harness.behavior.callRpc("reset_model_overrides", { levels: [{ projectId: "p1", sectionId: "s1" }, { projectId: GLOBAL, sectionId: null }] }) as { removed: number };
    expect(done.removed).toBe(2);
    expect(listSettingRows(db, "p1").map((row) => row.key)).toContain("writer.provider");
    expect(listSettingRows(db, GLOBAL).map((row) => row.key)).toContain("writer.provider");
    await harness.lifecycle.dispose();
  });

  it("the per-role reset accepts the writer fallback keys (the writer row sends them with its own, and one refused key refused the whole reset)", async () => {
    const { db, harness } = await seed();
    const keys = ["writer.fallback1.provider", "writer.fallback2.provider"];
    const reset = await harness.behavior.callRpc("reset_project_settings", { projectId: "p1", keys, expectedVersions: getSettingVersions(db, "p1", keys) }) as { ok: boolean };
    expect(reset).toMatchObject({ ok: true });
    expect(listSettingRows(db, "p1").map((row) => row.key)).not.toContain("writer.fallback1.provider");
    await harness.lifecycle.dispose();
  });
});
