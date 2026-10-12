import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { buildTaskBoard, readTaskCard } from "../src/rooms/runs/server/task-board";

/** 2026-10-12: with the BB Tasks plugin off, the owner asked for its board: all tasks of every chat by status, a card per task. */
function world() {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "bb"); setRunThread(db, "run", "thr_pm");
  createRun(db, "other", "Q", "bb");
  const task = (id:string, run = "run", extra:Record<string, unknown> = {}) => createTask(db, { id, runId:run, kind:"bb", contract:{ id, title:`Title of ${id}`, objective:"do it", acceptance:["works"], owns_paths:["a.ts"], depends_on:[], verification:[{ command:"npm test" }], ...extra } });
  const attempt = (id:string, taskId:string, run = "run", ...states:string[]) => {
    createAttempt(db, { id, runId:run, taskId });
    for (const state of states) transitionAttempt(db, id, state, state === "blocked" ? { reason:"needs_human: may I?" } : {});
  };
  const stage = (taskId:string, stageId:string, state:string, threadId?:string) =>
    recordStage(db, { runId:"run", taskId, stageId:stageId as never, state:state as never, input:"plan", ...(threadId ? { threadId } : {}) });
  return { db, task, attempt, stage };
}

describe("buildTaskBoard", () => {
  it("puts each task's latest attempt in its column and keeps done ones for the window", () => {
    const w = world();
    w.task("q"); w.attempt("aq", "q");
    w.task("w"); w.attempt("aw", "w", "run", "spawn_requested", "running"); w.stage("w", "writer-agent", "running", "thr_writer");
    w.task("c"); w.attempt("ac", "c", "run", "spawn_requested", "running"); w.stage("c", "writer-agent", "passed"); w.stage("c", "verification", "running");
    w.task("b"); w.attempt("ab", "b", "run", "spawn_requested", "running", "blocked");
    w.task("d"); w.attempt("ad", "d", "run", "spawn_requested", "running", "accepted");
    w.task("x", "other"); w.attempt("ax", "x", "other");
    w.task("old"); w.attempt("ao", "old", "run", "spawn_requested", "running", "blocked");
    w.task("old.2"); w.attempt("ao2", "old.2");

    const board = buildTaskBoard(w.db, { projectId:"P", doneSince:0 });
    const column = Object.fromEntries(board.map((item) => [item.taskId, item.column]));
    expect(column).toEqual({ q:"queued", w:"running", c:"checking", b:"blocked", d:"done", "old.2":"queued" });
    expect(board.find((item) => item.taskId === "b")).toMatchObject({ title:"Title of b", detail:"needs_human: may I?", pmThreadId:"thr_pm" });
    expect(buildTaskBoard(w.db, { projectId:"P", doneSince:Date.now() + 1000 }).some((item) => item.taskId === "d")).toBe(false);
    expect(buildTaskBoard(w.db, { doneSince:0 }).some((item) => item.taskId === "x")).toBe(true);
  });

  it("opens a card with the contract, stages, attempts and the threads that worked on it", () => {
    const w = world();
    w.task("t"); w.attempt("at", "t", "run", "spawn_requested", "running", "blocked");
    w.stage("t", "plan-critique", "passed", "thr_critic");
    const card = readTaskCard(w.db, { runId:"run", taskId:"t" })!;
    expect(card).toMatchObject({ title:"Title of t", state:"blocked", reason:"needs_human: may I?", pmThreadId:"thr_pm" });
    expect(card.contract).toMatchObject({ objective:"do it", acceptance:["works"], ownsPaths:["a.ts"], checks:["npm test"] });
    expect(card.attempts.map((attempt) => attempt.state)).toEqual(["blocked"]);
    expect(card.roots).toEqual([{ id:"thr_critic", role:"plan-critique" }]);
  });
});
