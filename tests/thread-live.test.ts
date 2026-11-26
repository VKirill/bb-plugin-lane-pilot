import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { readThreadLive } from "../src/rooms/runs/server";
import { rpcContract } from "../src/rooms/contracts";
import { tokenCursorRow } from "../src/rooms/usage/server";
import { createAttempt, createRun, createTask, openDatabase, setRunThread } from "../src/rooms/plugin-db";

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
    const live = readThreadLive(db, "thr_pm", tokenCursorRow)!;
    expect(live.role).toBe("pm");
    expect(live.items.map((item) => item.taskId).sort()).toEqual(["a", "b"]);
    expect(live.strips["run:a"]!.cells.map((cell) => `${cell.stageId}:${cell.state}`)).toEqual(["writer-agent:running"]);
  });

  it("a writer thread sees only its task; a thread Lane Pilot has no part in gets null", () => {
    const live = readThreadLive(db, "thr_writer_a", tokenCursorRow)!;
    expect(live).toMatchObject({ role: "writer", pmThreadId: "thr_pm" });
    expect(live.items.map((item) => item.taskId)).toEqual(["a"]);
    expect(readThreadLive(db, "thr_owner_chat", tokenCursorRow)).toBeNull();
  });
});

/** A PM chat whose run has dispatched nothing yet: the open session still shows, and only the workflows linked to its own runs. */
describe("PM session and linked workflow runs", () => {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  createRun(db, "lprun_a", "P", "cli"); setRunThread(db, "lprun_a", "thr_pm_a");
  createRun(db, "lprun_b", "P", "cli"); setRunThread(db, "lprun_b", "thr_pm_b");
  createRun(db, "lprun_c", "P", "cli"); setRunThread(db, "lprun_c", "thr_pm_c");
  const wfRun = (id: string, linkRunId: string | null, status: string) => db.prepare(
    "INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(id, "web-research", 1, "sha", '{"name":"Research"}', "P", linkRunId, status, Date.now(), Date.now());

  it("zero task attempts: session plus own linked workflows; other PM's and unlinked runs excluded", () => {
    wfRun("wfrun_live", "lprun_a", "running");
    wfRun("wfrun_failed", "lprun_a", "failed");
    wfRun("wfrun_canceled", "lprun_a", "canceled");
    wfRun("wfrun_other_pm", "lprun_b", "running");
    wfRun("wfrun_unlinked", null, "running");
    const live = readThreadLive(db, "thr_pm_a", tokenCursorRow)!;
    expect(live.items.filter((item) => item.kind === "task")).toEqual([]);
    expect(live.items.filter((item) => item.kind === "workflow").map((item) => `${item.runId}:${item.column}`).sort())
      .toEqual(["wfrun_canceled:done", "wfrun_failed:blocked", "wfrun_live:running"]);
    expect(live.items.find((item) => item.runId === "wfrun_canceled")).toMatchObject({ state: "canceled", column: "done" });
    expect(live.session).toMatchObject({ runId: "lprun_a", kind: "cli" });
  });

  it("an open run with no work reports its session; a closed run does not", () => {
    const live = readThreadLive(db, "thr_pm_c", tokenCursorRow)!;
    expect(live.session).toMatchObject({ runId: "lprun_c", kind: "cli" });
    expect(live.items).toEqual([]);
    db.prepare("UPDATE lane_pilot_run SET closed_at=? WHERE id='lprun_c'").run(Date.now());
    expect(readThreadLive(db, "thr_pm_c", tokenCursorRow)!.session).toBeNull();
  });

  it("the strict contract parses real task and workflow items (board internals stay server-side)", () => {
    createTask(db, { id: "t1", runId: "lprun_a", kind: "cli", contract: { id: "t1", title: "Task one", objective: "do it", acceptance: ["works"], owns_paths: ["a.ts"], depends_on: [], verification: [{ command: "npm test" }] } });
    createAttempt(db, { id: "att_t1", runId: "lprun_a", taskId: "t1" });
    const live = readThreadLive(db, "thr_pm_a", tokenCursorRow)!;
    expect(live.items.some((item) => item.kind === "task")).toBe(true);
    expect(live.items.some((item) => item.kind === "workflow")).toBe(true);
    expect(() => rpcContract.thread_live.output.parse(live)).not.toThrow();
  });
});
