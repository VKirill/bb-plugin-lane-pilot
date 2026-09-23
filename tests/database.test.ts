import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { casSetting, closeRun, createAttempt, createRun, createTask, importSettingsOnce, openDatabase } from "../src/database";

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
    const payload = {
      routingProfile: { path: "/tmp/r.yaml", text: "a: 1\n", sha256: "aa" },
      nightShift: { path: "/tmp/n.yaml", text: "b: 2\n", sha256: "bb" },
    };
    expect(importSettingsOnce(db, "A", payload).imported).toBe(true);
    expect(importSettingsOnce(db, "A", payload).imported).toBe(false);
    createRun(db, "run-close", "A");
    expect(closeRun(db, "run-close")).toBe(true);
    expect(closeRun(db, "run-close")).toBe(true);
    createRun(db, "run-open", "A");
    createTask(db, { id:"task-open", runId:"run-open", kind:"bb", contract:{} });
    createAttempt(db, { id:"attempt-open", runId:"run-open", taskId:"task-open" });
    expect(closeRun(db, "run-open")).toBe(false);
    expect((db.prepare("SELECT closed_at FROM lane_pilot_run WHERE id='run-open'").get() as {closed_at:number|null}).closed_at).toBeNull();
    await harness.lifecycle.dispose();
  });
});
