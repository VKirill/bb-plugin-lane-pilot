import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, saveProjectSetting, listSettingRows, casResetSettings, casUpsertSettings, casUpsertSetting, getSettingVersions } from "../src/database";
import plugin from "../server";

describe("explicit settings reset", () => {
  it("checks all CAS versions before deletion and deletes only requested project rows", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk:{ projects:{ get:async ({ projectId }) => ({ id:projectId, name:projectId, sources:[] }), list:async () => [] } } });
    const db = openDatabase(bb);
    saveProjectSetting(db, "p1", "helper.placement", "project_tree");
    saveProjectSetting(db, "p1", "helper.context_mode", "none");
    saveProjectSetting(db, "p2", "helper.placement", "project_tree");
    const rows = listSettingRows(db, "p1");
    const args = { projectId: "p1", keys: ["helper.placement", "helper.context_mode"], expectedVersions: { "helper.placement": 1, "helper.context_mode": 1 }, validationKeys: ["helper.placement", "helper.context_mode"], validatedRows: rows };
    expect(casResetSettings(db, { ...args, expectedVersions: { ...args.expectedVersions, "helper.context_mode": 0 } }).conflict).toBe(true);
    expect(listSettingRows(db, "p1")).toHaveLength(2);
    saveProjectSetting(db, "p1", "helper.skills", "review");
    const reset = casResetSettings(db, args);
    expect(reset).toMatchObject({ ok: true, versions: { "helper.placement": 2, "helper.context_mode": 2 } });
    expect(listSettingRows(db, "p1").map((row) => row.key)).toEqual(["helper.skills"]); // unrelated row is retained
    saveProjectSetting(db, "p1", "helper.placement", "project_tree");
    saveProjectSetting(db, "p1", "helper.context_mode", "selected");
    const duringValidation = listSettingRows(db, "p1");
    saveProjectSetting(db, "p1", "helper.context_mode", "none"); // linked key races asynchronous catalog validation
    expect(casResetSettings(db, { ...args, expectedVersions: { "helper.placement": 1, "helper.context_mode": 1 }, validatedRows: duringValidation }).conflict).toBe(true);
    expect(listSettingRows(db, "p1")).toHaveLength(3);
    expect(listSettingRows(db, "p2")).toHaveLength(1);
    saveProjectSetting(db,"p3","helper.placement","plugin"); // A reads generation 1
    const abaRows = listSettingRows(db,"p3");
    const abaReset = casResetSettings(db,{projectId:"p3",keys:["helper.placement"],expectedVersions:{"helper.placement":1},validationKeys:["helper.placement"],validatedRows:abaRows}); // B resets; tombstone generation 2
    expect(abaReset).toMatchObject({ok:true,versions:{"helper.placement":2}});
    const afterReset = casUpsertSettings(db,{projectId:"p3",changes:[{key:"helper.placement",value:"project_tree",expectedVersion:2}]}); // C writes generation 3
    expect(afterReset).toMatchObject({ok:true,versions:{"helper.placement":3}});
    const staleWriter = casUpsertSettings(db,{projectId:"p3",changes:[{key:"helper.placement",value:"plugin",expectedVersion:1}]}); // A resumes with its old token
    expect(staleWriter).toMatchObject({ok:false,conflict:true,versions:{"helper.placement":3},values:{"helper.placement":"project_tree"}});
    expect(listSettingRows(db,"p3").find((row) => row.key === "helper.placement")?.value).toBe("project_tree");
    await harness.lifecycle.dispose();
  });

  it("RPC rejects internal keys and incomplete linked selection without deleting overrides", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk:{ projects:{ get:async ({ projectId }) => ({ id:projectId, name:projectId, sources:[] }), list:async () => [] } } });
    const db = openDatabase(bb);
    saveProjectSetting(db, "p1", "helper.placement", "project_tree");
    await plugin(bb);
    try {
      const internal: any = await harness.behavior.callRpc("reset_project_settings", { projectId: "p1", keys: ["import.completed"], expectedVersions: { "import.completed": 0 } });
      expect(internal.ok).toBe(false);
      const partial: any = await harness.behavior.callRpc("reset_project_settings", { projectId: "p1", keys: ["writer.provider"], expectedVersions: { "writer.provider": 0 } });
      expect(partial.ok).toBe(false);
      const reset: any = await harness.behavior.callRpc("reset_project_settings", { projectId: "p1", keys: ["helper.placement"], expectedVersions: { "helper.placement": 1 } });
      expect(reset).toMatchObject({ ok: true, values: { "helper.placement": null }, versions: { "helper.placement": 2 } });
      const refreshed: any = await harness.behavior.callRpc("get_screen", { projectId: "p1" });
      expect(refreshed.explicitKeys).not.toContain("helper.placement");
      expect(refreshed.inheritedKeys).toContain("helper.placement");
      expect(refreshed.versions["helper.placement"]).toBe(2);
      expect(refreshed.values["helper.placement"]).toBe("plugin");
    } finally { await harness.lifecycle.dispose(); }
  });

  it("rolls back the setting row if the generation write fails", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    db.exec(`CREATE TRIGGER fail_helper_generation
      BEFORE INSERT ON lane_pilot_setting_generation
      WHEN NEW.project_id='p4' AND NEW.key='helper.placement'
      BEGIN SELECT RAISE(ABORT, 'forced_generation_failure'); END`);
    expect(() => casUpsertSetting(db, { projectId: "p4", key: "helper.placement", value: "project_tree", expectedVersion: 0 }))
      .toThrow(/forced_generation_failure/);
    expect(listSettingRows(db, "p4")).toEqual([]);
    expect(getSettingVersions(db, "p4", ["helper.placement"])).toEqual({ "helper.placement": 0 });
    await harness.lifecycle.dispose();
  });
});
