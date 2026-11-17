import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { migrations, createRun } from "../../src/rooms/plugin-db";

// Populated-upgrade packet for the attempt-ordinal CHECK widening (q2 review 2026-11-17). The fresh-DB tests prove
// the new schema works; this proves the _next/copy/drop/rename journal tail preserves rows, indexes, triggers and
// FKs on a database that already holds 0-2 ordinals, and that the single-transaction tail is all-or-nothing.
// TEST-ONLY: production migrations stay frozen until the dv DB review.
const tailStart = migrations.findIndex((statement) => statement.includes("lane_pilot_stage_receipt_next"));
const prefix = migrations.slice(0, tailStart);

const sha = (s: string) => s.padEnd(64, s);
const RECEIPT_ROWS = [
  { run_id: "run", task_id: "t", stage_id: "pm-read", contract_version: 1, state: "skipped", input_sha256: sha("i0"), output_sha256: null, attempt: 0, provider_id: null, model: null, thread_id: null, result_json: null, reason: "disabled by setting", updated_at: 1000 },
  { run_id: "run", task_id: "t", stage_id: "plan-critique", contract_version: 1, state: "passed", input_sha256: sha("i1"), output_sha256: sha("o1"), attempt: 1, provider_id: "claude-code", model: "claude-haiku-5-5", thread_id: "thr_p1", result_json: '{"verdict":"ok"}', reason: null, updated_at: 1001 },
  { run_id: "run", task_id: "t", stage_id: "writer-agent", contract_version: 1, state: "blocked", input_sha256: sha("i2"), output_sha256: null, attempt: 2, provider_id: "opencode2", model: "longcat/LongCat-2.5", thread_id: "thr_w2", result_json: null, reason: "Usage limit reached.", updated_at: 1002 },
];
const STAGE_EVENT_ROWS = [
  { id: 11, project_id: "proj", run_id: "run", task_id: "t", stage_id: "pm-read", state: "pending", input_sha256: sha("e0"), output_sha256: null, attempt: 0, occurred_at: 2000 },
  { id: 12, project_id: "proj", run_id: "run", task_id: "t", stage_id: "pm-read", state: "skipped", input_sha256: sha("e0"), output_sha256: null, attempt: 0, occurred_at: 2001 },
  { id: 13, project_id: "proj", run_id: "run", task_id: "t", stage_id: "plan-critique", state: "passed", input_sha256: sha("e1"), output_sha256: sha("oe1"), attempt: 1, occurred_at: 2002 },
  { id: 14, project_id: "proj", run_id: "run", task_id: "t", stage_id: "writer-agent", state: "blocked", input_sha256: sha("e2"), output_sha256: null, attempt: 2, occurred_at: 2003 },
];
const GATE_EVENT_ROWS = [
  { id: 21, project_id: "proj", run_id: "run", task_id: "t", gate: "owns-paths", status: "passed", input_sha256: sha("g0"), output_sha256: sha("og0"), attempt: 1, occurred_at: 3000 },
  { id: 22, project_id: "proj", run_id: "run", task_id: "t", gate: "accept", status: "rejected", input_sha256: sha("g1"), output_sha256: null, attempt: 2, occurred_at: 3001 },
  { id: 23, project_id: "proj", run_id: "run", task_id: "t", gate: "verification", status: "skipped", input_sha256: sha("g2"), output_sha256: null, attempt: 0, occurred_at: 3002 },
];

function hostWithPrefix() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = bb.storage.database();
  bb.storage.migrate(db, prefix);
  createRun(db, "run", "proj", "bb", "/repo");
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('t','run','bb','{}',1)").run();
  return { bb, db };
}

function seed(db: ReturnType<typeof hostWithPrefix>["db"]) {
  const receipt = db.prepare(`INSERT INTO lane_pilot_stage_receipt
    (run_id,task_id,stage_id,contract_version,state,input_sha256,output_sha256,attempt,provider_id,model,thread_id,result_json,reason,updated_at)
    VALUES (@run_id,@task_id,@stage_id,@contract_version,@state,@input_sha256,@output_sha256,@attempt,@provider_id,@model,@thread_id,@result_json,@reason,@updated_at)`);
  for (const row of RECEIPT_ROWS) receipt.run(row);
  const event = db.prepare(`INSERT INTO lane_pilot_stage_event
    (id,project_id,run_id,task_id,stage_id,state,input_sha256,output_sha256,attempt,occurred_at)
    VALUES (@id,@project_id,@run_id,@task_id,@stage_id,@state,@input_sha256,@output_sha256,@attempt,@occurred_at)`);
  for (const row of STAGE_EVENT_ROWS) event.run(row);
  const gate = db.prepare(`INSERT INTO lane_pilot_gate_event
    (id,project_id,run_id,task_id,gate,status,input_sha256,output_sha256,attempt,occurred_at)
    VALUES (@id,@project_id,@run_id,@task_id,@gate,@status,@input_sha256,@output_sha256,@attempt,@occurred_at)`);
  for (const row of GATE_EVENT_ROWS) gate.run(row);
}

const receipts = (db: ReturnType<typeof hostWithPrefix>["db"]) =>
  db.prepare("SELECT * FROM lane_pilot_stage_receipt ORDER BY stage_id").all();
const stageEvents = (db: ReturnType<typeof hostWithPrefix>["db"]) =>
  db.prepare("SELECT * FROM lane_pilot_stage_event ORDER BY id").all();
const gateEvents = (db: ReturnType<typeof hostWithPrefix>["db"]) =>
  db.prepare("SELECT * FROM lane_pilot_gate_event ORDER BY id").all();
const tableSql = (db: ReturnType<typeof hostWithPrefix>["db"], name: string) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string } | undefined)?.sql ?? "";
const objects = (db: ReturnType<typeof hostWithPrefix>["db"], kind: string, name: string) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?").all(kind, name) as Array<{ name: string }>;

describe("attempt-ordinal tail upgrade on a populated database", () => {
  it("preserves every row, index, trigger and FK while widening attempt's CHECK", () => {
    const { bb, db } = hostWithPrefix();
    seed(db);
    // The old CHECK really was the wall: ordinal 3 is rejected before the tail.
    expect(() => db.prepare("INSERT INTO lane_pilot_stage_receipt (run_id,task_id,stage_id,contract_version,state,input_sha256,output_sha256,attempt,provider_id,model,thread_id,result_json,reason,updated_at) VALUES ('run','t','verification',1,'passed','x','x',3,null,null,null,null,null,9)").run())
      .toThrow(/CHECK/);

    bb.storage.migrate(db, migrations);

    expect(receipts(db)).toEqual([...RECEIPT_ROWS].sort((a, b) => a.stage_id.localeCompare(b.stage_id)));
    expect(stageEvents(db)).toEqual(STAGE_EVENT_ROWS);
    expect(gateEvents(db)).toEqual(GATE_EVENT_ROWS);
    for (const table of ["lane_pilot_stage_receipt", "lane_pilot_stage_event", "lane_pilot_gate_event"]) {
      const sql = tableSql(db, table);
      expect(sql).toContain("attempt >= 0");
      expect(sql).not.toContain("BETWEEN 0 AND 2");
    }
    expect(tableSql(db, "lane_pilot_stage_receipt")).toContain("WITHOUT ROWID");
    // All three indexes the old tables carried must exist again on the rebuilt ones.
    for (const index of ["lane_pilot_stage_receipt_thread", "lane_pilot_stage_event_project_time", "lane_pilot_gate_event_project_time"])
      expect(objects(db, "index", index)).toHaveLength(1);
    // Both FKs on stage_receipt keep their parent and cascade action.
    expect(db.pragma("foreign_key_list(lane_pilot_stage_receipt)")).toEqual([
      { id: 0, seq: 0, table: "lane_pilot_task", from: "task_id", to: "id", on_update: "NO ACTION", on_delete: "CASCADE", match: "NONE" },
      { id: 1, seq: 0, table: "lane_pilot_run", from: "run_id", to: "id", on_update: "NO ACTION", on_delete: "CASCADE", match: "NONE" },
    ]);
    for (const trigger of ["lane_pilot_stage_event_no_update", "lane_pilot_stage_event_no_delete", "lane_pilot_gate_event_no_update", "lane_pilot_gate_event_no_delete"])
      expect(objects(db, "trigger", trigger)).toHaveLength(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) c FROM _bb_migrations").get()).toEqual({ c: migrations.length });

    // Post-upgrade the widened ordinal is a plain write in all three tables.
    db.prepare("INSERT INTO lane_pilot_stage_receipt (run_id,task_id,stage_id,contract_version,state,input_sha256,output_sha256,attempt,provider_id,model,thread_id,result_json,reason,updated_at) VALUES ('run','t','verification',1,'passed','x','x',3,'devin','swe-2-flash-medium','thr_w3',null,null,9)").run();
    db.prepare("INSERT INTO lane_pilot_stage_event (project_id,run_id,task_id,stage_id,state,input_sha256,output_sha256,attempt,occurred_at) VALUES ('proj','run','t','verification','passed','x','x',4,9)").run();
    db.prepare("INSERT INTO lane_pilot_gate_event (project_id,run_id,task_id,gate,status,input_sha256,output_sha256,attempt,occurred_at) VALUES ('proj','run','t','accept','passed','x','x',4,9)").run();

    // Append-only guards survive the rebuild on the new tables.
    expect(() => db.prepare("UPDATE lane_pilot_stage_event SET state='passed' WHERE id=11").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM lane_pilot_stage_event WHERE id=11").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM lane_pilot_gate_event WHERE id=21").run()).toThrow(/append-only/);
    // Autoincrement continued, not restarted: the next event id is above the seeded max.
    db.prepare("INSERT INTO lane_pilot_stage_event (project_id,run_id,task_id,stage_id,state,input_sha256,output_sha256,attempt,occurred_at) VALUES ('proj','run','t','verification','passed','y','y',3,10)").run();
    expect((db.prepare("SELECT MAX(id) m FROM lane_pilot_stage_event").get() as { m: number }).m).toBeGreaterThan(14);

    // Cascade still lands: deleting the parent task removes its receipts on the rebuilt table.
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM lane_pilot_task WHERE id='t'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM lane_pilot_stage_receipt WHERE task_id='t'").get()).toEqual({ c: 0 });
  });

  it("keeps sqlite_sequence's high-water mark when seq already exceeds max(id)", () => {
    const { bb, db } = hostWithPrefix();
    seed(db);
    // Scratch state: the counter ran ahead of the rows (manual/admin history) — seq 999 > max(id) 14.
    db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='lane_pilot_stage_event'").run();
    db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='lane_pilot_gate_event'").run();

    bb.storage.migrate(db, migrations);

    db.prepare("INSERT INTO lane_pilot_stage_event (project_id,run_id,task_id,stage_id,state,input_sha256,output_sha256,attempt,occurred_at) VALUES ('proj','run','t','verification','passed','z','z',3,10)").run();
    db.prepare("INSERT INTO lane_pilot_gate_event (project_id,run_id,task_id,gate,status,input_sha256,output_sha256,attempt,occurred_at) VALUES ('proj','run','t','accept','passed','z','z',3,10)").run();
    expect((db.prepare("SELECT MAX(id) m FROM lane_pilot_stage_event").get() as { m: number }).m).toBe(1000);
    expect((db.prepare("SELECT MAX(id) m FROM lane_pilot_gate_event").get() as { m: number }).m).toBe(1000);
  });

  it("rolls the whole tail back on a mid-batch failure and retries without losing a row", () => {
    const { bb, db } = hostWithPrefix();
    seed(db);
    // Corrupt the tail right after the stage_receipt rebuild: create/copy/drop/rename ran, then bogus SQL throws.
    const corrupted = [...migrations.slice(0, tailStart + 4), "THIS IS NOT SQL"];
    expect(() => bb.storage.migrate(db, corrupted)).toThrow();

    // One transaction = one boundary: nothing recorded, nothing renamed, rows back in the old table.
    expect(db.prepare("SELECT COUNT(*) c FROM _bb_migrations").get()).toEqual({ c: prefix.length });
    expect(objects(db, "table", "lane_pilot_stage_receipt_next")).toHaveLength(0);
    expect(tableSql(db, "lane_pilot_stage_receipt")).toContain("BETWEEN 0 AND 2");
    expect(receipts(db)).toEqual([...RECEIPT_ROWS].sort((a, b) => a.stage_id.localeCompare(b.stage_id)));

    bb.storage.migrate(db, migrations);
    expect(db.prepare("SELECT COUNT(*) c FROM _bb_migrations").get()).toEqual({ c: migrations.length });
    expect(receipts(db)).toEqual([...RECEIPT_ROWS].sort((a, b) => a.stage_id.localeCompare(b.stage_id)));
    expect(stageEvents(db)).toEqual(STAGE_EVENT_ROWS);
    expect(gateEvents(db)).toEqual(GATE_EVENT_ROWS);
    expect(tableSql(db, "lane_pilot_stage_receipt")).toContain("attempt >= 0");
  });
});
