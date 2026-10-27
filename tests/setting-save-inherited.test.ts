import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { casUpsertSetting, openDatabase } from "../src/rooms/storage/database";

// Live 2026-10-27 (full drill, provider_limit): the global writer.provider is «acp-cursor», which the older catalog's choices do not list;
// every project save of another key was refused on that inherited value.
describe("a project setting save", () => {
  it("is judged on the key it changes, not on an inherited value an older catalog does not list", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES('*','', 'writer.provider', '\"acp-cursor\"', 1, 1)").run();
    const saved = casUpsertSetting(db, { projectId: "p1", key: "writer.model", value: "lp-drill-model-that-does-not-exist", expectedVersion: 0 });
    expect(saved).toMatchObject({ ok: true });
  });

  it("still refuses the provider/effort pair when one of them is the key saved", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    expect(casUpsertSetting(db, { projectId: "p1", key: "writer.provider", value: "codex", expectedVersion: 0 })).toMatchObject({ ok: true });
    const effort = casUpsertSetting(db, { projectId: "p1", key: "writer.reasoning_effort", value: "nonsense", expectedVersion: 0 });
    expect(effort).toMatchObject({ ok: false });
  });
});
