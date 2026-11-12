import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, getRun, openDatabase, transitionAttempt } from "../src/rooms/plugin-db";
import { createWriterFinish } from "../src/rooms/writer/server/finish";
import { createWriterStart } from "../src/rooms/writer/server/start";
import { setJevForTests } from "@lane-pilot/jev";

afterEach(() => setJevForTests(null));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const config: PrototypeConfig = {
  projectId:"P", hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo",
  pmProviderId:"codex", pmModel:"codex-test", writerProviderId:"codex", writerModel:"codex-test",
};
const task = (id:string): TaskV2 => ({
  schema_version:2, id, title:"Write", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:["note.txt"], owns_paths:["note.txt"], never_touch:[], depends_on:[],
  objective:"write", acceptance:["file exists"], verify:"none", verification:[],
});

/**
 * Regression 1 (thr_exknr6pddz): a failed task's task-finished reaction must fire while the run is
 * still running — stability's breaker reads the run state. After the bus, three internal_error tasks
 * of single-task runs open the harness breaker; before it, refreshRun had already closed each run.
 */
describe("task-finished order: the harness breaker hears a failure on a live run", () => {
  it("three single-task runs ending internal_error within 15 min open the breaker", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    const seenAtFailure: Array<string | undefined> = [];
    const services = {
      activeWriterTasks:new Set<string>(),
      // The breaker: a task's failure counts only while its run is still running (the real rule reads the same column).
      stability:{ onTaskFailed:async ({ runId }: { runId:string }) => { seenAtFailure.push(getRun(db, runId)?.state); return true; } },
      startAfterAcceptance:() => undefined,
      // prepareRun dies right here: every start ends internal_error.
      runPolicyFor:undefined,
      runBudgetFor:() => ({ snapshot:() => ({ limits:{} }) }),
    };
    const ctx = {
      bb, db, state:{ disposed:false }, isDisposed:() => false, log:() => undefined,
      getThreadBounded:async () => ({ status:"idle" }), host:{ call:async () => ({}) },
      markCanceledWriterStages:() => undefined,
      effectiveProjectSettings:async () => ({ values:{} }),
      // prepareRun's first call throws: the start ends internal_error.
      runPolicyFor:() => { throw new Error("host offline"); },
      // The real refreshRun settles the run from the task's states; the fake marks it failed the same way.
      refreshRun:(runId:string) => { db.prepare("UPDATE lane_pilot_run SET state='blocked' WHERE id=?").run(runId); },
    };
    const start = createWriterStart(ctx as never, services as never);
    for (let i = 0; i < 3; i++) {
      const runId = `run-${i}`, taskId = `t-${i}`;
      createRun(db, runId, "P", "cli", "/repo");
      createTask(db, { id:taskId, runId, kind:"bb", contract:task(taskId) });
      createAttempt(db, { id:`a-${i}`, runId, taskId });
      start.startWriterTask({ projectId:"P", runId, taskId, firstAttemptId:`a-${i}`, pmThreadId:"pm",
        config, task:task(taskId), plan:"plan" });
      // The detached start frees the live-writer key in its finally — after the reactions ran.
      for (let n = 0; n < 200 && services.activeWriterTasks.has(`${runId}:${taskId}`); n++) await new Promise((wake) => setTimeout(wake, 5));
    }
    expect(seenAtFailure).toEqual(["pending", "pending", "pending"]);
  });
});

/**
 * Regression 4: the owner-word check reads the plugin store. A read that fails must surface, not read
 * as "no word yet" and hold a verified task for six hours (or block it on the owner's missing yes).
 */
describe("owner-word wait: a plugin-store read failure surfaces", () => {
  it("a kv read failure in the owner-word check rejects instead of waiting for the word", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    const highRisk = { ...task("t1"), risk: "high" as const };
    createTask(db, { id:"t1", runId:"run", kind:"bb", contract:highRisk });
    createAttempt(db, { id:"a-t1", runId:"run", taskId:"t1" });
    transitionAttempt(db, "a-t1", "spawn_requested");
    transitionAttempt(db, "a-t1", "running", { threadId:"writer-t1" });
    const ctx = {
      state:{ disposed:false }, db, isDisposed:() => false, log:() => undefined,
      getThreadBounded:async () => ({ status:"idle" }), host:{ call:async () => ({}) },
      bb:{ storage:bb.storage, log:{ warn() {}, error() {}, info() {} },
        sdk:{ threads:{ stop:async () => undefined, events:{ list:async () => [] }, get:async () => ({ status:"idle" }),
            output:async () => ({ text:"done" }) },
          files:{ read:async () => ({ content:"note" }) },
          plugins:{ callRpc:async ({ method }:{ method:string }) => method === "files"
            ? { outcome:"available", files:[{ path:"note.txt", revision:"r1" }], initialPatches:[{ path:"note.txt", patch:"@@\n+note\n", truncated:false }] }
            : { outcome:"available", patches:{ "note.txt":{ outcome:"available", patch:{ path:"note.txt", patch:"@@\n+note\n", truncated:false } } } } },
          environments:{ list:async () => [{ id:"env-1" }] } } },
    };
    const finish = createWriterFinish(ctx as never, {
      validateWriterResult:async () => ({ status:"accepted", output:"done", produced:["note.txt"], verification:[] }),
      persistWriterAcceptance:async () => ({ state:"passed" }),
      workspaceDirt:async () => ({ ok:true, snapshots:[] }),
      stageHelperSettings:async () => ({}),
      runBudgetFor:() => ({ snapshot:() => ({ limits:{} }) }),
    } as never);
    const get = vi.spyOn(bb.storage.kv, "get").mockImplementation(async (key: string) => {
      if (key === "lp.task.words") throw new Error("store down");
      return null;
    });
    await expect(finish.finishWriterAttempt({ projectId:"P", config, task:highRisk, runId:"run", taskId:"t1",
      attemptId:"a-t1", pmThreadId:"pm", writerThreadId:"writer-t1", dirtBefore:[] })).rejects.toThrow("store down");
    get.mockRestore();
  });
});

/**
 * Regression 3: the landed reactions launch at the merge point — before the merge intent is cleared —
 * with failures logged. A dead settings load must surface on the log, not reject unhandled.
 */
describe("landed reactions: a dead database is logged, not swallowed", () => {
  it("loadProjectSettings rejects during landed() → the failure reaches the log", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    const logs:string[] = [];
    const ctx = { state:{ disposed:false }, db, log:(line:string) => logs.push(line),
      isDisposed:() => false, bb };
    const finish = createWriterFinish(ctx as never, { runBudgetFor:() => ({ snapshot:() => ({ limits:{} }) }) } as never);
    const landed = (finish as unknown as { landed?: (input:Record<string,unknown>, basePath:string, commit:string | null, produced:string[], live:boolean, worktreePath:string | null, green:readonly string[] | undefined) => void }).landed;
    expect(typeof landed).toBe("function");
    // The dead database: loadProjectSettings throws inside the reaction.
    const dead = { ...ctx, db:{ prepare:() => { throw new Error("database is closed"); } } };
    const deadFinish = createWriterFinish(dead as never, { runBudgetFor:() => ({ snapshot:() => ({ limits:{} }) }) } as never);
    (deadFinish as unknown as { landed:(input:Record<string,unknown>, basePath:string, commit:string | null, produced:string[], live:boolean, worktreePath:string | null, green:readonly string[] | undefined) => void }).landed(
      { projectId:"P", runId:"run", taskId:"t1", attemptId:"a-t1", writerThreadId:"w", pmThreadId:"pm",
        config:{ hostId:"h" }, task:task("t1") },
      "/repo", "sha", ["note.txt"], false, "/repo/.lane-pilot/worktrees/a-t1", []);
    for (let n = 0; n < 100 && !logs.some((line) => line.includes("landed reactions of t1 failed")); n++) await new Promise((wake) => setTimeout(wake, 5));
    expect(logs.some((line) => line.includes("landed reactions of t1 failed"))).toBe(true);
    expect(logs.some((line) => line.includes("database is closed"))).toBe(true);
  });
});
