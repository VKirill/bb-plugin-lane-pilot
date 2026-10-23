import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { readThreadLive } from "../src/rooms/runs/server/thread-live";
import { createAttempt, createRun, createTask, openDatabase, setRunThread } from "../src/rooms/storage/database";

/** The thread's info panel asks what Lane Pilot does for a chat: a PM sees its tasks, a writer its own task, any other thread nothing. */
describe("what Lane Pilot does for a thread", () => {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  createRun(db, "run", "P", "cli"); setRunThread(db, "run", "thr_pm");
  createRun(db, "other", "P", "cli"); setRunThread(db, "other", "thr_pm2");
  const task = (id: string, run = "run") => createTask(db, { id, runId: run, kind: "cli", contract: { id, title: `Title of ${id}`, objective: "do it", acceptance: ["works"], owns_paths: ["a.ts"], depends_on: [], verification: [{ command: "npm test" }] } });
  task("a"); task("b"); task("c", "other");
  createAttempt(db, { id: "att_a", runId: "run", taskId: "a" });
  createAttempt(db, { id: "att_b", runId: "run", taskId: "b" });
  createAttempt(db, { id: "att_c", runId: "other", taskId: "c" });
  db.prepare("UPDATE lane_pilot_attempt SET thread_id='thr_writer_a', state='running' WHERE id='att_a'").run();
  db.prepare("INSERT INTO lane_pilot_stage_event(project_id,run_id,task_id,stage_id,state,input_sha256,attempt,occurred_at) VALUES ('P','run','a','writer-agent','running','x',0,?)").run(Date.now());

  it("a PM chat sees the tasks of its own runs, with their stage cells", () => {
    const live = readThreadLive(db, "thr_pm")!;
    expect(live.role).toBe("pm");
    expect(live.items.map((item) => item.taskId).sort()).toEqual(["a", "b"]);
    expect(live.strips["run:a"]!.cells.map((cell) => `${cell.stageId}:${cell.state}`)).toEqual(["writer-agent:running"]);
  });

  it("a writer thread sees only its task; a thread Lane Pilot has no part in gets null", () => {
    const live = readThreadLive(db, "thr_writer_a")!;
    expect(live).toMatchObject({ role: "writer", pmThreadId: "thr_pm" });
    expect(live.items.map((item) => item.taskId)).toEqual(["a"]);
    expect(readThreadLive(db, "thr_owner_chat")).toBeNull();
  });
});
