import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../src/rooms/storage/database";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { buildTaskGraph } from "../src/rooms/runs/server/task-graph";
import { taskSteps } from "../src/rooms/native-agent/ui/task-graph-view";

/**
 * 2026-10-12: the owner saw «В очереди: 8» as a flat list of ids (Клиенты, cakekeeper: ck-20 foundation, then ck-21 and ck-22
 * side by side, then ck-23, then ck-24/25/26 side by side, then ck-27 and ck-28) and asked what goes in turn and what in parallel.
 */
function world() {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "bb");
  const task = (id:string, depends_on:string[] = [], title = id) => createTask(db, { id, runId:"run", kind:"bb", contract:{ id, title, depends_on } });
  const attempt = (id:string, taskId:string, ...states:string[]) => {
    createAttempt(db, { id, runId:"run", taskId });
    for (const state of states) transitionAttempt(db, id, state, state === "blocked" ? { reason:"retry limit 2 exhausted" } : {});
  };
  const waits = (taskId:string, reason:string) => recordStage(db, { runId:"run", taskId, stageId:"writer-agent", state:"pending", input:"plan", reason });
  return { db, task, attempt, waits };
}

describe("buildTaskGraph", () => {
  it("lays the live cakekeeper chain out as steps: depends_on edges follow redispatched names", () => {
    const w = world();
    w.task("ck-20.2", [], "UI foundation"); w.attempt("a20", "ck-20.2", "spawn_requested", "running");
    w.task("ck-21.2", ["ck-20"]); w.attempt("a21", "ck-21.2");
    w.task("ck-22.2", ["ck-20.2"]); w.attempt("a22", "ck-22.2");
    w.task("ck-23.2", ["ck-21.2", "ck-22.2"]); w.attempt("a23", "ck-23.2");
    for (const id of ["ck-24.2", "ck-25.2", "ck-26.2"]) { w.task(id, ["ck-23.2"]); w.attempt(`a-${id}`, id); w.waits(id, "waiting for depends_on: ck-23.2"); }
    w.task("ck-27.2", ["ck-24.2", "ck-25.2", "ck-26.2"]); w.attempt("a27", "ck-27.2");
    w.task("ck-28", ["ck-26.2"]); w.attempt("a28", "ck-28");
    w.task("old-done"); w.attempt("ad", "old-done", "spawn_requested", "running", "accepted");

    const graph = buildTaskGraph(w.db, "run");
    expect(graph.nodes.map((node) => node.id)).not.toContain("old-done");
    expect(graph.nodes.find((node) => node.id === "ck-20.2")).toMatchObject({ state:"running", title:"UI foundation" });
    expect(graph.nodes.find((node) => node.id === "ck-24.2")?.state).toBe("waiting");
    expect(graph.edges).toContainEqual({ from:"ck-20.2", to:"ck-21.2", kind:"depends" });

    const steps = taskSteps(graph);
    const at = (step:number) => [...steps].filter(([, value]) => value === step).map(([id]) => id).sort();
    expect(at(0)).toEqual(["ck-20.2"]);
    expect(at(1)).toEqual(["ck-21.2", "ck-22.2"]);
    expect(at(2)).toEqual(["ck-23.2"]);
    expect(at(3)).toEqual(["ck-24.2", "ck-25.2", "ck-26.2"]);
    expect(at(4)).toEqual(["ck-27.2", "ck-28"]);
  });

  it("shows a queue wait on another task's files or folder, and the blocked task a chain waits for", () => {
    const w = world();
    w.task("a"); w.attempt("aa", "a", "spawn_requested", "running");
    w.task("b"); w.attempt("ab", "b"); w.waits("b", "waiting for a (thread thr_1): owns_paths overlap");
    w.task("c"); w.attempt("ac", "c"); w.waits("c", "waiting for a (thread thr_1): one writer at a time in a folder without git");
    w.task("dead"); w.attempt("ad", "dead", "spawn_requested", "running", "blocked");
    w.task("d", ["dead"]); w.attempt("adep", "d");

    const graph = buildTaskGraph(w.db, "run");
    expect(graph.edges).toEqual(expect.arrayContaining([
      { from:"a", to:"b", kind:"files" }, { from:"a", to:"c", kind:"folder" }, { from:"dead", to:"d", kind:"depends" },
    ]));
    expect(graph.nodes.find((node) => node.id === "dead")?.state).toBe("blocked");
  });
});
