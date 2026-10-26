import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { classifyFailure } from "../src/rooms/runs/failure-class";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { countChargedAttempts, createAttempt, createRun, createTask, getAttempt, listUnansweredWriterQuestions, openDatabase, savePrototypeConfig, saveTaskPlan, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { createWriterFinish } from "../src/rooms/writer/server/finish";
import { markAnsweredByDefault, SAFE_DEFAULT_ANSWER, WRITER_QUESTION_WAIT_MS } from "../src/rooms/writer/server/question-default";
import { createWriterQuestionTimeout } from "../src/rooms/writer/server/question-timeout";

const WORKSPACE = "/ws";
const REASON = "needs_human: May I add tests/x.test.ts to owns_paths?";
const T0 = 1_800_000_000_000;

const task: TaskV2 = {
  schema_version:2, id:"T1", title:"Add the fixture", risk:"low", lane:"writer", project_cwd:WORKSPACE, read_first:[], interfaces:[], invariants:[], out_of_scope:[],
  expected_outputs:["a.txt"], owns_paths:["a.txt"], never_touch:[], depends_on:[], objective:"Make a.txt", acceptance:["a.txt exists"], verify:"tests", verification:[],
};

function sweepWorld(options: { threadStatus?: string } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
  const sends: Array<{ threadId: string; input: Array<{ text: string }> }> = [];
  harness.sdk.stub("threads.get", async (args:{ threadId:string }) => args.threadId === "thr_w" ? { id:args.threadId, status:options.threadStatus ?? "idle" } : null);
  harness.sdk.stub("threads.send", async (args:unknown) => { sends.push(args as never); return undefined; });
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("files.read", async () => { throw new Error("file does not exist"); });
  harness.sdk.stub("files.write", async () => undefined);
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, { projectId:"proj1", hostId:"h1", pmWorkspacePath:WORKSPACE, writerWorkspacePath:WORKSPACE, pmProviderId:"p", pmModel:"pm", writerProviderId:"p", writerModel:"wm" });
  createTask(db, { id:"T1", runId:"run1", kind:"bb", contract:task });
  saveTaskPlan(db, "T1", "Plan for T1");
  createAttempt(db, { id:"a1", runId:"run1", taskId:"T1" });
  db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason=?, thread_id='thr_w', workspace_path='/ws/worktrees/a1', updated_at=? WHERE id='a1'").run(REASON, T0);
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId:"run1", taskId:"T1", stageId, state:"failed", input:"Plan for T1", reason:REASON });
  const abandoned: string[] = [];
  const startWriterTask = vi.fn();
  const services = { activeWriterTasks:new Set<string>(), startWriterTask, providerRetry:{ abandon:async (id:string) => { abandoned.push(id); } } } as unknown as Services;
  return { bb, db, ctx, sends, abandoned, startWriterTask, services, timeout: createWriterQuestionTimeout(ctx, services) };
}

describe("a writer's question nobody answers", () => {
  it("is left alone for the first hour", async () => {
    const w = sweepWorld();
    expect(await w.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS - 1)).toEqual([]);
    expect(getAttempt(w.db, "a1")?.state).toBe("blocked");
    expect(w.sends).toEqual([]);
  });

  it("is answered by the machine with the safest default after an hour: the same writer goes on, no attempt is spent", async () => {
    const w = sweepWorld();
    expect(await w.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"answered_by_default" }]);
    expect(getAttempt(w.db, "a1")?.state).toBe("running");
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]!.threadId).toBe("thr_w");
    expect(w.sends[0]!.input[0]!.text).toContain("do not widen anything");
    expect(w.sends[0]!.input[0]!.text).toContain(SAFE_DEFAULT_ANSWER.split("\n")[2]!);
    expect(w.startWriterTask).toHaveBeenCalledTimes(1);
    expect(countChargedAttempts(w.db, "run1", "T1")).toBe(1);
    expect(listUnansweredWriterQuestions(w.db)).toEqual([]);
  });

  it("ends the attempt, with the question in its reason, when the writer asked again after the default or its thread is gone", async () => {
    const again = sweepWorld();
    await markAnsweredByDefault(again.bb.storage.kv as never, "run1", "T1", T0);
    expect(await again.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"ended" }]);
    const row = getAttempt(again.db, "a1")!;
    expect(row.state).toBe("blocked");
    expect(row.reason).toMatch(/^verdict_block: question_unanswered: .*May I add tests\/x\.test\.ts to owns_paths\?/);
    expect(classifyFailure("blocked", row.reason).cls).toBe("contract");
    expect(listUnansweredWriterQuestions(again.db)).toEqual([]);
    expect(again.abandoned).toEqual(["thr_w"]);
    expect(again.sends).toEqual([]);

    const gone = sweepWorld({ threadStatus:"active" });
    expect(await gone.timeout.sweepWriterQuestions(T0 + 2 * WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"ended" }]);
    expect(getAttempt(gone.db, "a1")?.reason).toMatch(/^verdict_block: question_unanswered:/);
  });

  it("does not touch a question of a task whose writer is still finishing", async () => {
    const busy = sweepWorld();
    busy.services.activeWriterTasks.add("run1:T1");
    expect(await busy.timeout.sweepWriterQuestions(T0 + 5 * WRITER_QUESTION_WAIT_MS)).toEqual([]);
    expect(getAttempt(busy.db, "a1")?.state).toBe("blocked");
  });
});

describe("a writer that asks again after the machine's default answer", () => {
  const config: PrototypeConfig = { projectId:"P", hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo", pmProviderId:"codex", pmModel:"m", writerProviderId:"codex", writerModel:"m" };
  function finishWorld() {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    createTask(db, { id:"t1", runId:"run", kind:"bb", contract:{ ...task, id:"t1", project_cwd:"/repo" } });
    createAttempt(db, { id:"a1", runId:"run", taskId:"t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId:"writer-1" });
    const ctx = { state:{ disposed:false }, bb:{ storage:bb.storage, log:{ warn() {}, error() {} }, sdk:{ threads:{ stop:async () => undefined, events:{ list:async () => [] },
      get:async () => ({ status:"idle" }), output:async () => ({ text:"NEEDS_HUMAN: May I widen owns_paths?" }) }, files:{ read:async () => ({ content:"x" }) } } },
      db, getThreadBounded:async () => ({ status:"idle" }), host:{ call:async () => ({}) }, isDisposed:() => false, log:() => undefined };
    const finish = createWriterFinish(ctx as never, { validateWriterResult:async () => ({ status:"accepted" }), workspaceDirt:async () => ({ ok:true, snapshots:[] }),
      runBudgetFor:() => ({ snapshot:() => ({ limits:{} }) }) } as never);
    return { bb, db, run: () => finish.finishWriterAttempt({ projectId:"P", config, task:{ ...task, id:"t1", project_cwd:"/repo" }, runId:"run", taskId:"t1", attemptId:"a1", pmThreadId:"pm", writerThreadId:"writer-1", dirtBefore:[] }) };
  }

  it("keeps the first question as a question and ends the second as a contract block", async () => {
    const first = finishWorld();
    expect(await first.run()).toMatchObject({ status:"blocked", reason:"needs_human: May I widen owns_paths?" });

    const second = finishWorld();
    await markAnsweredByDefault(second.bb.storage.kv as never, "run", "t1", T0);
    const result = await second.run();
    expect(result).toMatchObject({ status:"blocked" });
    expect(String(result.reason)).toMatch(/^verdict_block: question_unanswered: .*May I widen owns_paths\?/);
    expect(classifyFailure("blocked", String(result.reason)).cls).toBe("contract");
  });
});
