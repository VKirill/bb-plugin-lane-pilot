import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, transitionAttempt } from "../src/rooms/storage/database";
import { cancelAttemptById } from "../src/rooms/runs/server/cancel";
import { recordStage } from "../src/rooms/runs/server/stage-records";

const task: TaskV2 = {
  schema_version:2, id:"t1", title:"Write", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:["note.txt"], owns_paths:["note.txt"], never_touch:[], depends_on:[],
  objective:"write", acceptance:["file exists"], verify:"none", verification:[],
};

/** A queued task whose stages run: its attempt has no writer thread yet. `stopFails` makes every helper stop throw. */
function world(options:{ stopFails?:boolean } = {}) {
  const stopped:string[] = [];
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{
    stop:async ({ threadId }:{ threadId:string }) => {
      stopped.push(threadId);
      if (options.stopFails) throw new Error("thread already gone");
      return {} as never;
    },
    get:async () => ({ status:"idle" }) as never,
    listRunning:async () => [],
  } } });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", "/repo");
  createTask(db, { id:"t1", runId:"run", kind:"bb", contract:task });
  createAttempt(db, { id:"a1", runId:"run", taskId:"t1" });
  // Mirrors the queued branch of core's cancelQueuedAttempt: the attempt ends canceled at once.
  const cancelQueuedAttempt = (attempt:{ id:string }) => {
    transitionAttempt(db, attempt.id, "canceled");
    return { ok:true, state:"canceled", reason:null };
  };
  const ctx = { bb, db, cancelQueuedAttempt } as never;
  const cancel = () => cancelAttemptById(ctx, "a1");
  const stage = (stageId:"pm-read"|"plan-critique"|"specialist-review") => listStageReceipts(db, "run", "t1").find((row) => row.stageId === stageId);
  return { db, bb, stopped, cancel, stage };
}

describe("cancel stops the task's running stage helper threads", () => {
  it("stops a running pm-read thread and closes its receipt canceled", async () => {
    const w = world();
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"pending", input:"write" });
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"running", input:"write", threadId:"pm-read-thread" });
    await expect(w.cancel()).resolves.toMatchObject({ ok:true, state:"canceled", reason:null });
    expect(w.stopped).toEqual(["pm-read-thread"]);
    expect(w.stage("pm-read")).toMatchObject({ state:"canceled", threadId:"pm-read-thread", reason:"task canceled" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"canceled" });
  });

  it("stops a running plan-critique or specialist-review thread too", async () => {
    const w = world();
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"pending", input:"write" });
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"running", input:"write", threadId:"pm-thread" });
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"passed", input:"write", threadId:"pm-thread" });
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"plan-critique", state:"running", input:"write", threadId:"critic-thread" });
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"specialist-review", state:"pending", input:"write" });
    await w.cancel();
    expect(w.stopped).toEqual(["critic-thread"]);
    expect(w.stage("plan-critique")).toMatchObject({ state:"canceled" });
    expect(w.stage("specialist-review")).toMatchObject({ state:"canceled" });
    expect(w.stage("pm-read")).toMatchObject({ state:"passed" });
  });

  it("closes a pending stage receipt that has no thread canceled, without a stop call", async () => {
    const w = world();
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"pending", input:"write" });
    await w.cancel();
    expect(w.stopped).toEqual([]);
    expect(w.stage("pm-read")).toMatchObject({ state:"canceled", threadId:null });
  });

  it("a failing stop is ignored and the cancel still returns ok", async () => {
    const w = world({ stopFails:true });
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"pending", input:"write" });
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"running", input:"write", threadId:"pm-read-thread" });
    await expect(w.cancel()).resolves.toMatchObject({ ok:true, state:"canceled" });
    expect(w.stopped).toEqual(["pm-read-thread"]);
    expect(w.stage("pm-read")).toMatchObject({ state:"canceled" });
  });

  it("a stage result arriving after the cancel does not reopen the receipt", async () => {
    const w = world();
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"pending", input:"write" });
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"running", input:"write", threadId:"pm-read-thread" });
    await w.cancel();
    // The late result is dropped, not thrown: a throw failed the whole dispatch of the canceled task.
    expect(() => recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"passed", input:"write", threadId:"pm-read-thread" })).not.toThrow();
    expect(w.stage("pm-read")).toMatchObject({ state:"canceled" });
  });

  it("leaves an accepted task's stage receipts and threads alone", async () => {
    const w = world();
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"pending", input:"write" });
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"running", input:"write", threadId:"pm-read-thread" });
    recordStage(w.db, { runId:"run", taskId:"t1", stageId:"pm-read", state:"passed", input:"write", threadId:"pm-read-thread" });
    transitionAttempt(w.db, "a1", "spawn_requested");
    transitionAttempt(w.db, "a1", "running", { threadId:"writer-1" });
    transitionAttempt(w.db, "a1", "accepted");
    await expect(w.cancel()).resolves.toMatchObject({ ok:false, state:"accepted" });
    expect(w.stopped).toEqual([]);
    expect(w.stage("pm-read")).toMatchObject({ state:"passed" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"accepted" });
  });
});
