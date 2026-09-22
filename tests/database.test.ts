import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { casSetting, openDatabase } from "../src/database";

describe("section 9 storage.database DDL", () => {
  it("covers DDL, PK isolation, CAS and project isolation", async () => {
    const {bb,harness} = createFakePluginHost({pluginId:"lane-pilot"});
    const db = openDatabase(bb);
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='lane_pilot_project_settings'").get() as {sql:string};
    expect(schema.sql).toContain("PRIMARY KEY (project_id, binding_id, key)");
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,key,value,updated_at) VALUES (?,?,?,?)")
      .run("A", "writer.provider", '"codex"', 1);
    expect(() => db.prepare("INSERT INTO lane_pilot_project_settings(project_id,key,value,updated_at) VALUES (?,?,?,?)")
      .run("A", "writer.provider", '"kimi"', 2)).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,updated_at) VALUES (?,?,?,?,?)")
      .run("A", "binding_1", "writer.provider", '"kimi"', 3);
    expect(casSetting(db,{projectId:"A",key:"writer.provider",value:"agy",expectedVersion:1})).toBe(true);
    expect(casSetting(db,{projectId:"A",key:"writer.provider",value:"grok",expectedVersion:1})).toBe(false);
    expect((db.prepare("SELECT COUNT(*) count FROM lane_pilot_project_settings WHERE project_id='B'").get() as {count:number}).count).toBe(0);
    const winners = [2,2].map((version) => casSetting(db,{projectId:"A",key:"writer.provider",value:"race",expectedVersion:version}));
    expect(winners.filter(Boolean)).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
});
