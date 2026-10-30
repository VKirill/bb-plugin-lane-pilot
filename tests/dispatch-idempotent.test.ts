import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { DISPATCH_STAGES_PENDING } from "../src/rooms/runs/constants";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import type { TaskV2 } from "../src/rooms/contracts";
import {
  createAttempt, createRun, createTask, getAttempt, listAttemptsForTask, listStageReceipts, openDatabase,
  saveProjectSetting, savePrototypeConfig, saveTaskPlan, setRunThread,
} from "../src/rooms/storage/database";

const projectId = "project-test";
const pmThreadId = "pm-thread";
const runId = "run-idem";
const config = {
  projectId, hostId:"host-test", pmWorkspacePath:"/tmp/pm", writerWorkspacePath:"/tmp/writer",
  pmProviderId:"claude-code", pmModel:"claude-test", writerProviderId:"codex", writerModel:"codex-test",
};
const task: TaskV2 = {
  schema_version:2, display_title: "Тестовая задача", kind: "feature", area: "feature:suite-green", id:"suite-green", title:"Idempotent dispatch", risk:"low", lane:"writer", project_cwd:config.writerWorkspacePath,
  read_first:["README.md"], interfaces:["i"], invariants:["inv"], out_of_scope:["out"], expected_outputs:["hello.txt"],
  owns_paths:["hello.txt"], never_touch:[".git/**"], depends_on:[], objective:"create hello", acceptance:["never"],
  verify:"none", verification:[],
};

/** The git-base host call is the first long wait after the attempt exists: held here until the test releases it. */
async function setup(options:{ failBase?:boolean } = {}) {
  let releaseBase!: () => void;
  const baseHeld = new Promise<void>((resolve) => { releaseBase = resolve; });
  let baseCalls = 0;
  const stopped: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId:"lane-pilot",
    sdk:{ threads:{
      getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role:"pm", lanePilotRunId:runId } : { role:"writer" },
      spawn: async () => ({ id:"writer-idem" }),
      wait: async () => new Promise(() => undefined),
      get: async ({ threadId }) => threadId === pmThreadId ? { id:pmThreadId, status:"idle", projectId } as never : { id:threadId, status:"active" } as never,
      output: async () => ({ text:"" }),
      list: async () => [] as never,
      stop: async ({ threadId }) => { stopped.push(threadId); return {} as never; },
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
    "lane_pilot_dispatch_writer", { confirm: true, objective: "Проверка диспетча", plan, task:{ ...task, ...next } }, { threadId:pmThreadId, projectId },
  ))) as Record<string, unknown>;
  return { db, harness, dispatch, releaseBase, baseCalls: () => baseCalls, stopped };
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

  it("returns the existing task for the same contract and plan sent under a different id", async () => {
    const { db, harness, dispatch, releaseBase } = await setup();
    const first = await dispatch();
    const again = await dispatch({ id:"suite-green-alias" });
    expect(again).toMatchObject({ taskId:"suite-green", attemptId:first.attemptId, state:"queued", deduplicated:true });
    expect(taskCount(db)).toBe(1);
    expect(listAttemptsForTask(db, runId, "suite-green")).toHaveLength(1);
    releaseBase();
    await harness.lifecycle.dispose();
  });

  it("does not deduplicate a different contract sent under a different id", async () => {
    const { db, harness, dispatch, releaseBase } = await setup();
    await dispatch();
    const other = await dispatch({ id:"suite-other", objective:"create something else entirely" });
    expect(other.deduplicated).toBeUndefined();
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

  it("blocks a queued attempt whose stages died with a reload and left no pipeline record instead of starting its writer", async () => {
    const { db, harness } = await setup();
    createTask(db, { id:"orphan", runId, kind:"bb", contract:task });
    createAttempt(db, { id:"attempt-orphan", runId, taskId:"orphan" });
    db.prepare("UPDATE lane_pilot_attempt SET reason=? WHERE id='attempt-orphan'").run(DISPATCH_STAGES_PENDING);
    await harness.behavior.callRpc("resume_runs", { projectId });
    expect(getAttempt(db, "attempt-orphan")).toMatchObject({ state:"blocked", reason:expect.stringContaining("send the task again") });
    await harness.lifecycle.dispose();
  });

  // Live: SelfyStudio cabinet-hide-analyzing-line (2026-10-12) and duo-low-balance-paywall (2026-10-13). A reload came
  // while pm-read's helper ran; the attempt was blocked and the writer stages failed, but pm-read stayed «running» for good.
  it("closes and stops the helper stages of a dispatch a reload interrupted", async () => {
    const { db, harness, stopped } = await setup();
    createTask(db, { id:"orphan", runId, kind:"bb", contract:task });
    createAttempt(db, { id:"attempt-orphan", runId, taskId:"orphan" });
    db.prepare("UPDATE lane_pilot_attempt SET state='queued', reason=? WHERE id='attempt-orphan'").run(DISPATCH_STAGES_PENDING);
    recordStage(db, { runId, taskId:"orphan", stageId:"pm-read", state:"pending", input:"plan" });
    recordStage(db, { runId, taskId:"orphan", stageId:"pm-read", state:"running", input:"plan", threadId:"thr-pm-read" });
    recordStage(db, { runId, taskId:"orphan", stageId:"plan-critique", state:"pending", input:"plan" });
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId, taskId:"orphan", stageId, state:"pending", input:"plan" });
    await harness.behavior.callRpc("resume_runs", { projectId });
    const stages = Object.fromEntries(listStageReceipts(db, runId, "orphan").map((row) => [row.stageId, row]));
    expect(stages["pm-read"]).toMatchObject({ state:"blocked", threadId:"thr-pm-read", reason:expect.stringContaining("send the task again") });
    expect(stages["plan-critique"]).toMatchObject({ state:"blocked" });
    expect(stopped).toEqual(["thr-pm-read"]);
    expect(Object.values(stages).filter((row) => row.state === "pending" || row.state === "running")).toEqual([]);
    await harness.lifecycle.dispose();
  });

  /** The state a Lane Pilot deploy left (duo-low-balance-paywall, 2026-10-13 17:05): the dispatch's pipeline run, pm-read on its helper. */
  function interruptedDispatch(db:ReturnType<typeof openDatabase>, pipelines = 1) {
    createTask(db, { id:"orphan", runId, kind:"bb", contract:task });
    saveTaskPlan(db, "orphan", "Plan for the interrupted dispatch");
    createAttempt(db, { id:"attempt-orphan", runId, taskId:"orphan" });
    db.prepare("UPDATE lane_pilot_attempt SET state='queued', reason=? WHERE id='attempt-orphan'").run(DISPATCH_STAGES_PENDING);
    recordStage(db, { runId, taskId:"orphan", stageId:"pm-read", state:"pending", input:"plan" });
    recordStage(db, { runId, taskId:"orphan", stageId:"pm-read", state:"running", input:"plan", threadId:"thr-pm-read" });
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId, taskId:"orphan", stageId, state:"pending", input:"plan" });
    for (let i = 0; i < pipelines; i++) {
      db.prepare(`INSERT INTO lane_pilot_wf_run(id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,link_task_id,link_attempt_id,
        status,reason,inputs_json,created_at,updated_at) VALUES(?,?,'lp-task-pipeline',1,'x','{}',?,?,'orphan','attempt-orphan','interrupted','interrupted_by_reload',?,?,?)`)
        .run(`wfrun_old${i}`, i ? `lp-task:attempt-orphan:resume-${i}` : "lp-task:attempt-orphan", projectId, runId,
          JSON.stringify({ taskId:"orphan", attemptId:"attempt-orphan" }), Date.now() + i, Date.now() + i);
    }
  }
  const pipelineKeys = (db:ReturnType<typeof openDatabase>) => (db.prepare("SELECT idem_key FROM lane_pilot_wf_run WHERE link_attempt_id='attempt-orphan' ORDER BY created_at").all() as Array<{ idem_key:string }>).map((row) => row.idem_key);

  // Live: SelfyStudio analytics-product-names (2026-10-08), cabinet-hide-analyzing-line (2026-10-12) and duo-low-balance-paywall
  // (2026-10-13), each dispatched 8-30 s before a release reloaded Lane Pilot. The attempt was blocked «send the task again».
  it("starts the stages of a dispatch a reload interrupted again, and its writer once they pass", async () => {
    const { db, harness, stopped, releaseBase } = await setup();
    interruptedDispatch(db);
    const resumed = await harness.behavior.callRpc("resume_runs", { projectId }) as { resumed:string[] };
    expect(resumed.resumed).toContain("attempt-orphan");
    expect(stopped).toEqual(["thr-pm-read"]);
    expect(getAttempt(db, "attempt-orphan")).toMatchObject({ state:"queued", reason:DISPATCH_STAGES_PENDING });
    expect(pipelineKeys(db)).toEqual(["lp-task:attempt-orphan", "lp-task:attempt-orphan:resume-1"]);
    for (let i = 0; i < 200 && ((row) => !row || row.threadId === "thr-pm-read")(listStageReceipts(db, runId, "orphan").find((row) => row.stageId === "pm-read")); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    // pm-read ran again from nothing (one line of read_first is below the threshold here), not from the dead helper.
    expect(listStageReceipts(db, runId, "orphan").find((row) => row.stageId === "pm-read")).toMatchObject({ state:"skipped", threadId:null });
    releaseBase();
    for (let i = 0; i < 200 && getAttempt(db, "attempt-orphan")?.state === "queued"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getAttempt(db, "attempt-orphan")?.state).not.toBe("queued");
    expect(getAttempt(db, "attempt-orphan")?.reason).not.toContain("send the task again");
    expect(listAttemptsForTask(db, runId, "orphan")).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("blocks a dispatch reloads interrupted three times for the PM instead of starting it a fourth time", async () => {
    const { db, harness } = await setup();
    interruptedDispatch(db, 3);
    await harness.behavior.callRpc("resume_runs", { projectId });
    expect(getAttempt(db, "attempt-orphan")).toMatchObject({ state:"blocked", reason:expect.stringContaining("reloads interrupted it 3 times") });
    expect(pipelineKeys(db)).toHaveLength(3);
    await harness.lifecycle.dispose();
  });

  it("leaves a dispatch this instance is running alone when recovery runs meanwhile", async () => {
    const { db, harness, dispatch, releaseBase } = await setup();
    const first = await dispatch();
    expect(first).toMatchObject({ state:"queued", stagesPending:true });
    await harness.behavior.callRpc("resume_runs", { projectId });
    expect(getAttempt(db, String(first.attemptId))).toMatchObject({ state:"queued", reason:DISPATCH_STAGES_PENDING });
    releaseBase();
    for (let i = 0; i < 200 && getAttempt(db, String(first.attemptId))?.state === "queued"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getAttempt(db, String(first.attemptId))?.state).not.toBe("queued");
    expect((db.prepare("SELECT COUNT(*) n FROM lane_pilot_wf_run WHERE link_attempt_id=?").get(String(first.attemptId)) as { n:number }).n).toBe(1);
    await harness.lifecycle.dispose();
  });
});
