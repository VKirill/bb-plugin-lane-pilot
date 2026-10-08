import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { DISPATCH_STAGES_PENDING } from "../src/constants";
import type { TaskV2 } from "../src/contracts";
import {
  createAttempt, createRun, createTask, getAttempt, listAttemptsForTask, listStageReceipts, openDatabase,
  saveProjectSetting, savePrototypeConfig, setRunThread,
} from "../src/rooms/storage/database";

const projectId = "project-test";
const pmThreadId = "pm-thread";
const runId = "run-idem";
const config = {
  projectId, hostId:"host-test", pmWorkspacePath:"/tmp/pm", writerWorkspacePath:"/tmp/writer",
  pmProviderId:"claude-code", pmModel:"claude-test", writerProviderId:"codex", writerModel:"codex-test",
};
const task: TaskV2 = {
  schema_version:2, id:"suite-green", title:"Idempotent dispatch", risk:"low", lane:"writer", project_cwd:config.writerWorkspacePath,
  read_first:["README.md"], interfaces:["i"], invariants:["inv"], out_of_scope:["out"], expected_outputs:["hello.txt"],
  owns_paths:["hello.txt"], never_touch:[".git/**"], depends_on:[], objective:"create hello", acceptance:["never"],
  verify:"none", verification:[],
};

/** The git-base host call is the first long wait after the attempt exists: held here until the test releases it. */
async function setup(options:{ failBase?:boolean } = {}) {
  let releaseBase!: () => void;
  const baseHeld = new Promise<void>((resolve) => { releaseBase = resolve; });
  let baseCalls = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId:"lane-pilot",
    sdk:{ threads:{
      getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role:"pm", lanePilotRunId:runId } : { role:"writer" },
      spawn: async () => ({ id:"writer-idem" }),
      wait: async () => new Promise(() => undefined),
      get: async ({ threadId }) => threadId === pmThreadId ? { id:pmThreadId, status:"idle", projectId } as never : { id:threadId, status:"active" } as never,
      output: async () => ({ text:"" }),
      list: async () => [] as never,
    }, providers:{
      list: async () => [{ id:"codex", available:true, capabilities:{ supportsServiceTier:true }, serviceTiers:[{ id:"default", label:"Default" }] }] as never,
      models: async () => ({ models:[{ id:"codex-test", model:"codex-test",
        supportedReasoningEfforts:["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })) }] as never }),
    }, files:{
      read: async () => ({ content:"fixture\n" }),
      write: async () => ({ ok:true }),
    } },
    experimental_callHostRpc: async (call) => {
      if (call.method === "gitOwnershipBase") {
        baseCalls += 1;
        await baseHeld;
        if (options.failBase) throw new Error("host went away");
        return { hostId:"host-test", status:"not-git" as const, branch:null, headSha:null, baseRef:null, baseSha:null, compareCommitted:false, reason:"fixture" };
      }
      if (call.method === "classifyPlan") {
        return { hostId:"host-test", status:"ok", effort:"xhigh", reason:null, planSha256:"a", sentPlanSha256:"a", sourceLength:1, sentLength:1 };
      }
      if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
      return { hostId:"host-test", exitCode:0, stdout:String((call.input as { command?:string }).command ?? "").includes("porcelain") ? "[]" : "", stderr:"" };
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  saveProjectSetting(db, projectId, "plan_critique.enabled", false);
  saveProjectSetting(db, projectId, "memory.enabled", false);
  createRun(db, runId, projectId, "bb", config.writerWorkspacePath);
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const dispatch = async (next:Partial<TaskV2> = {}, plan = "Plan for the idempotent dispatch") => JSON.parse(String(await harness.behavior.callAgentTool(
    "lane_pilot_dispatch_writer", { confirm:true, plan, task:{ ...task, ...next } }, { threadId:pmThreadId, projectId },
  ))) as Record<string, unknown>;
  return { db, harness, dispatch, releaseBase, baseCalls: () => baseCalls };
}

const taskCount = (db:ReturnType<typeof openDatabase>) => (db.prepare("SELECT COUNT(*) count FROM lane_pilot_task WHERE run_id=?").get(runId) as { count:number }).count;

describe("dispatch answers early and is idempotent", () => {
  beforeEach(() => { process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "50"; });
  afterEach(() => { delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS; });

  it("answers queued with the task and attempt while the stages still run, then starts the writer once they pass", async () => {
    const { db, harness, dispatch, releaseBase } = await setup();
    const first = await dispatch();
    expect(first).toMatchObject({ runId, taskId:"suite-green", state:"queued", stagesPending:true, attemptId:expect.any(String), writerThreadId:null });
    // Persisted before the answer: the task, a queued attempt that says why it waits, the writer stages pending.
    expect(taskCount(db)).toBe(1);
    expect(getAttempt(db, String(first.attemptId))).toMatchObject({ state:"queued", reason:DISPATCH_STAGES_PENDING, thread_id:null });
    expect(listStageReceipts(db, runId, "suite-green").find((row) => row.stageId === "writer-agent")?.state).toBe("pending");

    releaseBase();
    for (let i = 0; i < 200 && getAttempt(db, String(first.attemptId))?.state === "queued"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const started = getAttempt(db, String(first.attemptId));
    expect(started?.state).not.toBe("queued");
    expect(started?.reason).not.toBe(DISPATCH_STAGES_PENDING);
    expect(listAttemptsForTask(db, runId, "suite-green")).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("returns the existing task for the same id, contract and plan instead of a duplicate", async () => {
    const { db, harness, dispatch, releaseBase } = await setup();
    const first = await dispatch();
    const again = await dispatch();
    const third = await dispatch();
    expect(again).toMatchObject({ taskId:"suite-green", attemptId:first.attemptId, state:"queued", deduplicated:true });
    expect(third).toMatchObject({ taskId:"suite-green", attemptId:first.attemptId, deduplicated:true });
    expect(taskCount(db)).toBe(1);
    expect(listAttemptsForTask(db, runId, "suite-green")).toHaveLength(1);
    releaseBase();
    await harness.lifecycle.dispose();
  });

  // §2: while the first task is still open, another contract or plan under its id starts no second writer.
  it("refuses another contract or plan under the same id while the first task is open, with no new task", async () => {
    const { db, harness, dispatch, releaseBase } = await setup();
    await dispatch();
    const otherContract = await dispatch({ objective:"create hello, then something else" });
    expect(otherContract).toMatchObject({ ok:false, error:{ code:"task_in_progress" }, runningTaskId:"suite-green" });
    const otherPlan = await dispatch({}, "A different plan under the same contract");
    expect(otherPlan).toMatchObject({ ok:false, error:{ code:"task_in_progress" } });
    expect(taskCount(db)).toBe(1);
    releaseBase();
    await harness.lifecycle.dispose();
  });

  it("does not deduplicate after 30 minutes: an open task then refuses the resend instead", async () => {
    const { db, harness, dispatch, releaseBase } = await setup();
    await dispatch();
    db.prepare("UPDATE lane_pilot_task SET created_at=? WHERE id='suite-green'").run(Date.now() - 31 * 60_000);
    const later = await dispatch();
    expect(later.deduplicated).toBeUndefined();
    expect(later).toMatchObject({ ok:false, error:{ code:"task_in_progress" } });
    expect(taskCount(db)).toBe(1);
    releaseBase();
    await harness.lifecycle.dispose();
  });

  it("does not return a task that ended blocked: the same contract is dispatched again under a new id", async () => {
    const { db, harness, dispatch, releaseBase } = await setup({ failBase:true });
    const first = await dispatch();
    releaseBase();
    for (let i = 0; i < 200 && getAttempt(db, String(first.attemptId))?.state === "queued"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getAttempt(db, String(first.attemptId))).toMatchObject({ state:"blocked", reason:expect.stringContaining("host went away") });
    const again = await dispatch();
    expect(again).toMatchObject({ taskId:"suite-green.2" });
    expect(again.deduplicated).toBeUndefined();
    await harness.lifecycle.dispose();
  });

  it("answers a fast dispatch with the final result as before", async () => {
    const { harness, dispatch, releaseBase } = await setup();
    releaseBase();
    const result = await dispatch();
    expect(result).toMatchObject({ runId, taskId:"suite-green", state:"queued", attemptId:expect.any(String) });
    expect(result.stagesPending).toBeUndefined();
    await harness.lifecycle.dispose();
  });

  it("blocks a queued attempt whose stages died with a reload instead of starting its writer", async () => {
    const { db, harness } = await setup();
    createTask(db, { id:"orphan", runId, kind:"bb", contract:task });
    createAttempt(db, { id:"attempt-orphan", runId, taskId:"orphan" });
    db.prepare("UPDATE lane_pilot_attempt SET reason=? WHERE id='attempt-orphan'").run(DISPATCH_STAGES_PENDING);
    await harness.behavior.callRpc("resume_runs", { projectId });
    expect(getAttempt(db, "attempt-orphan")).toMatchObject({ state:"blocked", reason:expect.stringContaining("send the task again") });
    await harness.lifecycle.dispose();
  });
});
