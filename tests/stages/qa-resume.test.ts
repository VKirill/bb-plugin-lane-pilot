import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, createTask, listStageReceipts, openDatabase } from "../../src/database";
import { recordStage } from "../../src/server/stage-records";
import { createQaStages } from "../../src/server/stages/qa";
import type { ServerCore } from "../../src/server/core";

const verdict = "Итог: провалено.\n```json\n{\"verdict\":\"failed\",\"summary\":\"«Выбрать» does nothing\",\"cases\":[{\"case\":\"3\",\"viewport\":\"375\",\"result\":\"failed\"}]}\n```";

function setup(threadStatus: () => string) {
  const stopped: string[] = [];
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{
    get: async ({ threadId }) => ({ id:threadId, status:threadStatus() }) as never,
    events: { list: async ({ threadId }) => (threadStatus() === "idle"
      ? [{ type:"turn/started", threadId, seq:1 }, { type:"turn/completed", threadId, seq:2, data:{ status:"completed" } }]
      : [{ type:"turn/started", threadId, seq:1 }]) as never },
    output: async () => ({ output:verdict }) as never,
    stop: async ({ threadId }) => { stopped.push(threadId); return {} as never; },
  } } });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "bb", "/w");
  for (const id of ["qa", "lost"]) createTask(db, { id, runId:"run", kind:"bb", contract:{} as never });
  let disposed = false;
  const ctx = { bb, db, isDisposed:() => disposed } as unknown as ServerCore;
  return { db, ctx, stopped, dispose:() => { disposed = true; } };
}

function runningQa(db: ReturnType<typeof openDatabase>, taskId: string, result: Record<string, unknown>) {
  recordStage(db, { runId:"run", taskId, stageId:"browser-qa", state:"pending", input:"qa" });
  recordStage(db, { runId:"run", taskId, stageId:"browser-qa", state:"running", input:"qa", attempt:1, result });
  db.prepare("UPDATE lane_pilot_stage_receipt SET updated_at=updated_at-60000 WHERE task_id=?").run(taskId);
}

const qaState = (db: ReturnType<typeof openDatabase>, taskId: string) => listStageReceipts(db, "run", taskId).find((row) => row.stageId === "browser-qa");

describe("browser checks left running by a reload (live: gc-qa-free-session.5)", () => {
  it("stores the verdict of a check thread that finished while the plugin was reloading", async () => {
    const { db, ctx } = setup(() => "idle");
    runningQa(db, "qa", { configuredHostId:"host_mini", spawnAttempted:true, threadId:"thr_qa", link:"@thread:thr_qa" });
    runningQa(db, "lost", { configuredHostId:"host_mini", spawnAttempted:true });
    const qa = createQaStages(ctx);
    expect(qa.resumeBrowserQaThreads()).toBe(2);
    // A claim without a thread id never confirmed a start: blocked, so the PM may run it again.
    expect(qaState(db, "lost")).toMatchObject({ state:"blocked", reason:"browser_qa_dispatch_lost_in_reload" });
    await expect.poll(() => qaState(db, "qa")?.state).toBe("failed");
    expect(qaState(db, "qa")).toMatchObject({ reason:"«Выбрать» does nothing", result:{ threadId:"thr_qa", verdict:"failed" } });
  });

  it("stops a check still working past its deadline, and leaves a check started by this process alone", async () => {
    const { db, ctx, stopped } = setup(() => "active");
    runningQa(db, "qa", { spawnAttempted:true, threadId:"thr_slow", deadline:Date.now() - 1000, timeoutSec:900 });
    const qa = createQaStages(ctx);
    runningQa(db, "lost", { spawnAttempted:true });
    db.prepare("UPDATE lane_pilot_stage_receipt SET updated_at=? WHERE task_id='lost'").run(Date.now() + 1000);
    expect(qa.resumeBrowserQaThreads()).toBe(1);
    await expect.poll(() => qaState(db, "qa")?.state).toBe("blocked");
    expect(qaState(db, "qa")?.reason).toBe("browser_qa_thread_timeout_900s");
    expect(stopped).toEqual(["thr_slow"]);
    expect(qaState(db, "lost")?.state).toBe("running");
  });

  it("an unload during the wait leaves the stage running for the next load", async () => {
    const { db, ctx, dispose } = setup(() => "active");
    runningQa(db, "qa", { spawnAttempted:true, threadId:"thr_qa", deadline:Date.now() + 60_000, timeoutSec:900 });
    const qa = createQaStages(ctx);
    qa.resumeBrowserQaThreads();
    dispose();
    await new Promise((wake) => setTimeout(wake, 1500));
    expect(qaState(db, "qa")?.state).toBe("running");
  });
});
