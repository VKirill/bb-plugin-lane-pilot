import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, createTask, listStageReceipts, openDatabase } from "../../src/rooms/plugin-db";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { createQaStages } from "../../src/rooms/qa/server/qa";
import type { ServerCore } from "../../src/rooms/contracts/server";

const verdict = "Итог: провалено.\n```json\n{\"verdict\":\"failed\",\"summary\":\"«Выбрать» does nothing\",\"cases\":[{\"case\":\"3\",\"viewport\":\"375\",\"result\":\"failed\"}]}\n```";

const QA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const QA_FILE = { content: QA_PNG.toString("base64"), contentEncoding: "base64", sha256: "a".repeat(64), sizeBytes: QA_PNG.length };

function setup(threadStatus: () => string, verdictText = verdict, readFile?: (path: string) => Promise<typeof QA_FILE>) {
  const stopped: string[] = [];
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{
    threads:{
      get: async ({ threadId }) => ({ id:threadId, status:threadStatus() }) as never,
      events: { list: async ({ threadId }) => (threadStatus() === "idle"
        ? [{ type:"turn/started", threadId, seq:1 }, { type:"turn/completed", threadId, seq:2, data:{ status:"completed" } }]
        : [{ type:"turn/started", threadId, seq:1 }]) as never },
      output: async () => ({ output:verdictText }) as never,
      storageLocation: async () => ({ hostId:"qa-host", storageRootPath:"/thread-store/thr_qa" }) as never,
      stop: async ({ threadId }) => { stopped.push(threadId); return {} as never; },
    },
    files: { read: async ({ path }: { path?: string }) => readFile ? readFile(path ?? "") : path?.includes("/artifacts/browser-qa/") ? QA_FILE : Promise.reject(new Error("ENOENT")) },
  } });
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
    runningQa(db, "qa", { configuredHostId:"host_mini", spawnAttempted:true, threadId:"thr_qa", link:"@thread:thr_qa",
      expect:{ cases:[{ id:"c1", text:"3", login:null }], viewports:["375"] } });
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
    runningQa(db, "qa", { spawnAttempted:true, threadId:"thr_slow", deadline:Date.now() - 1000, timeoutSec:900,
      expect:{ cases:[{ id:"c1", text:"3", login:null }], viewports:["375"] } });
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
    runningQa(db, "qa", { spawnAttempted:true, threadId:"thr_qa", deadline:Date.now() + 60_000, timeoutSec:900,
      expect:{ cases:[{ id:"c1", text:"3", login:null }], viewports:["375"] } });
    const qa = createQaStages(ctx);
    qa.resumeBrowserQaThreads();
    dispose();
    await new Promise((wake) => setTimeout(wake, 1500));
    expect(qaState(db, "qa")?.state).toBe("running");
  });

  it("adopts a verdict only against the case×viewport matrix frozen at dispatch", async () => {
    const sparse = "```json\n{\"verdict\":\"passed\",\"summary\":\"ok\",\"cases\":[{\"case\":\"c1\",\"viewport\":\"375\",\"result\":\"passed\"}]}\n```";
    const { db, ctx } = setup(() => "idle", sparse);
    runningQa(db, "qa", { spawnAttempted:true, threadId:"thr_qa",
      expect:{ cases:[{ id:"c1", text:"one", login:null }, { id:"c2", text:"two", login:null }], viewports:["375","1280"] } });
    const qa = createQaStages(ctx);
    qa.resumeBrowserQaThreads();
    await expect.poll(() => qaState(db, "qa")?.state).toBe("blocked");
    expect(qaState(db, "qa")?.reason).toContain("browser_qa_coverage_failed");
    expect(qaState(db, "qa")?.reason).toContain("missing:c2@375");
  });

  it("blocks adoption when the stored check carries no expected matrix", async () => {
    const { db, ctx } = setup(() => "idle");
    runningQa(db, "qa", { spawnAttempted:true, threadId:"thr_qa" });
    const qa = createQaStages(ctx);
    qa.resumeBrowserQaThreads();
    await expect.poll(() => qaState(db, "qa")?.state).toBe("blocked");
    expect(qaState(db, "qa")?.reason).toBe("browser_qa_expectation_unavailable");
  });

  it("blocks adoption when the stored matrix carries an invalid viewport", async () => {
    const { db, ctx } = setup(() => "idle");
    runningQa(db, "qa", { spawnAttempted:true, threadId:"thr_qa",
      expect:{ cases:[{ id:"c1", text:"one", login:null }], viewports:["banana"] } });
    const qa = createQaStages(ctx);
    qa.resumeBrowserQaThreads();
    await expect.poll(() => qaState(db, "qa")?.state).toBe("blocked");
    expect(qaState(db, "qa")?.reason).toBe("browser_qa_expectation_unavailable");
  });

  it("adopts a passed verdict when the stored matrix is covered exactly once", async () => {
    const pass = "```json\n{\"verdict\":\"passed\",\"summary\":\"ok\",\"cases\":[{\"case\":\"c1\",\"viewport\":\"375\",\"result\":\"passed\"},{\"case\":\"c1\",\"viewport\":\"1280\",\"result\":\"passed\"}],\"artifacts\":[{\"case\":\"c1\",\"viewport\":\"375\",\"path\":\"artifacts/browser-qa/c1-375.png\"},{\"case\":\"c1\",\"viewport\":\"1280\",\"path\":\"artifacts/browser-qa/c1-1280.png\"}]}\n```";
    const { db, ctx } = setup(() => "idle", pass);
    runningQa(db, "qa", { spawnAttempted:true, threadId:"thr_qa",
      expect:{ cases:[{ id:"c1", text:"one", login:null }], viewports:["375","1280"] } });
    const qa = createQaStages(ctx);
    qa.resumeBrowserQaThreads();
    await expect.poll(() => qaState(db, "qa")?.state).toBe("passed");
  });

  it("keeps a verified screenshot ref when a sparse matrix still blocks on coverage", async () => {
    const sparse = "```json\n{\"verdict\":\"passed\",\"summary\":\"ok\",\"cases\":[{\"case\":\"c1\",\"viewport\":\"375\",\"result\":\"passed\"}],\"artifacts\":[{\"case\":\"c1\",\"viewport\":\"375\",\"path\":\"artifacts/browser-qa/c1-375.png\"}]}\n```";
    const { db, ctx } = setup(() => "idle", sparse);
    runningQa(db, "qa", { spawnAttempted:true, threadId:"thr_qa",
      expect:{ cases:[{ id:"c1", text:"one", login:null }], viewports:["375","1280"] } });
    const qa = createQaStages(ctx);
    qa.resumeBrowserQaThreads();
    await expect.poll(() => qaState(db, "qa")?.state).toBe("blocked");
    const row = qaState(db, "qa");
    expect(row?.reason).toContain("browser_qa_coverage_failed");
    expect(row?.reason).toContain("missing:c1@1280");
    expect(row?.result).toMatchObject({ artifacts:[{ case:"c1", viewport:"375", hostId:"qa-host",
      path:"/thread-store/thr_qa/artifacts/browser-qa/c1-375.png" }] });
  });

  it("keeps the coverage reason and names unreadable evidence on a sparse matrix", async () => {
    const sparse = "```json\n{\"verdict\":\"passed\",\"summary\":\"ok\",\"cases\":[{\"case\":\"c1\",\"viewport\":\"375\",\"result\":\"passed\"}],\"artifacts\":[{\"case\":\"c1\",\"viewport\":\"375\",\"path\":\"artifacts/browser-qa/c1-375.png\"}]}\n```";
    const { db, ctx } = setup(() => "idle", sparse, async () => { throw new Error("ENOENT"); });
    runningQa(db, "qa", { spawnAttempted:true, threadId:"thr_qa",
      expect:{ cases:[{ id:"c1", text:"one", login:null }], viewports:["375","1280"] } });
    const qa = createQaStages(ctx);
    qa.resumeBrowserQaThreads();
    await expect.poll(() => qaState(db, "qa")?.state).toBe("blocked");
    const row = qaState(db, "qa");
    expect(row?.reason).toContain("browser_qa_coverage_failed");
    expect(row?.reason).not.toContain("browser_qa_evidence_failed");
    expect(row?.result).toMatchObject({ artifactProblems: expect.arrayContaining(["artifact_unreadable:c1@375", "missing_evidence:c1@375"]) });
  });
});
