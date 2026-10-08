import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase } from "../src/database";
import { writerReuseStats } from "../src/writer-reuse-stats";

it("counts cold writer threads per accepted task, continued turns, areas and time to acceptance", () => {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "bb", "/repo");
  const now = 50_000_000;
  const task = (id:string, area?:string) => {
    createTask(db, { id, runId:"run", kind:"bb", contract:area ? { area } : {} });
    db.prepare("UPDATE lane_pilot_task SET created_at=? WHERE id=?").run(now, id);
  };
  const attempt = (id:string, taskId:string, thread:string, state:string, minutes:number) => {
    createAttempt(db, { id, runId:"run", taskId });
    db.prepare("UPDATE lane_pilot_attempt SET thread_id=?, state=?, updated_at=? WHERE id=?").run(thread, state, now + minutes * 60_000, id);
  };
  task("a", "page:/cards"); task("b", "page:/cards"); task("c"); task("d");
  attempt("a1", "a", "thr_1", "accepted", 10);
  attempt("b1", "b", "thr_1", "validation_failed", 12);
  attempt("b2", "b", "thr_1", "accepted", 14);
  attempt("c1", "c", "thr_2", "validation_failed", 20);
  attempt("c2", "c", "thr_3", "accepted", 40);
  attempt("d1", "d", "thr_4", "blocked", 5);
  expect(writerReuseStats(db, "P", 0)).toEqual({ tasks:4, accepted:3, coldThreads:4, continued:2, coldPerAccepted:1.3,
    areaShare:50, tasksPerArea:2, medianMinutesToAccept:14 });
  expect(writerReuseStats(db, "P", now + 1).tasks).toBe(0);
});
