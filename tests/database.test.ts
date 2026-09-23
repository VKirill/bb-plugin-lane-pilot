import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { casSetting, closeRun, createAttempt, createRun, createTask, importSettingsOnce, migrations, openDatabase } from "../src/database";

describe("section 9 storage.database DDL", () => {
  it("migrates an existing populated database without losing rows and expands the run state check", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations.slice(0, 9));
    db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,created_at,updated_at,kind,closed_at) VALUES ('old-run','A','running',1,2,'bb',NULL)").run();
    db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,created_at,updated_at,kind,closed_at) VALUES ('legacy-closed','A','running',2,3,'bb',3)").run();
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES ('old-task','old-run','bb','{}',1)").run();
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,created_at,updated_at,attempt_no,dirt_before_json) VALUES ('old-attempt','old-run','old-task','accepted',1,2,1,'[]')").run();
    openDatabase(bb);
    const runSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='lane_pilot_run'").get() as {sql:string};
    expect(runSchema.sql).toContain("'closed'");
    expect(db.prepare("SELECT id,state,closed_at,closed_by FROM lane_pilot_run WHERE id='old-run'").get()).toEqual({ id:"old-run", state:"running", closed_at:null, closed_by:null });
    expect(db.prepare("SELECT state,closed_at,closed_by FROM lane_pilot_run WHERE id='legacy-closed'").get()).toEqual({ state:"closed", closed_at:3, closed_by:"legacy" });
    expect((db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE id='old-attempt'").get() as {count:number}).count).toBe(1);
    createRun(db, "new-run", "A");
    createTask(db, { id:"new-task", runId:"new-run", kind:"bb", contract:{} });
    createAttempt(db, { id:"new-attempt", runId:"new-run", taskId:"new-task" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("UPDATE lane_pilot_run SET state='closed' WHERE id='old-run'").run();
    await harness.lifecycle.dispose();
  });

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
    expect(closeRun(db, "run-close", "cli")).toBe(true);
    expect(closeRun(db, "run-close", "cli")).toBe(true);
    expect((db.prepare("SELECT state,closed_at,closed_by FROM lane_pilot_run WHERE id='run-close'").get() as {state:string;closed_at:number|null;closed_by:string|null})).toMatchObject({ state:"closed", closed_by:"cli" });
    createRun(db, "run-open", "A");
    createTask(db, { id:"task-open", runId:"run-open", kind:"bb", contract:{} });
    createAttempt(db, { id:"attempt-open", runId:"run-open", taskId:"task-open" });
    expect(closeRun(db, "run-open", "rpc")).toBe(false);
    expect((db.prepare("SELECT closed_at FROM lane_pilot_run WHERE id='run-open'").get() as {closed_at:number|null}).closed_at).toBeNull();
    await harness.lifecycle.dispose();
  });
});
