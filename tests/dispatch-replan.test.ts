import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import type { TaskV2 } from "../src/rooms/contracts";
import {
  createRun, getAttempt, listAttemptsForTask, listStageReceipts, openDatabase,
  saveProjectSetting, savePrototypeConfig, setRunThread,
} from "../src/rooms/storage/database";

const projectId = "project-test";
const pmThreadId = "pm-thread";
const runId = "run-revive";
const config = {
  projectId, hostId:"host-test", pmWorkspacePath:"/tmp/pm", writerWorkspacePath:"/tmp/writer",
  pmProviderId:"claude-code", pmModel:"claude-test", writerProviderId:"codex", writerModel:"codex-test",
};
const task: TaskV2 = {
  schema_version:2, display_title: "Тестовая задача", kind: "feature", area: "feature:replan-me", id:"replan-me", title:"Idempotent dispatch", risk:"low", lane:"writer", project_cwd:config.writerWorkspacePath,
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
      spawn: async () => ({ id:"writer-revive" }),
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
  const tool = async (name:string, input:Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool(name, input, { threadId:pmThreadId, projectId }))) as Record<string, unknown>;
  return { db, harness, dispatch, tool, releaseBase, baseCalls: () => baseCalls, stopped };
}

const taskCount = (db:ReturnType<typeof openDatabase>) => (db.prepare("SELECT COUNT(*) count FROM lane_pilot_task WHERE run_id=?").get(runId) as { count:number }).count;
const until = async (check:() => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); };

// Live: Vampirism Fire replanned five times by canceling the queue and sending every task again; each resend was a new task id, a new
// attempt row and a new pm-read and plan critique. A hold keeps the task and its attempt; a cancel of a queued task sent again unchanged does too.
describe("a replan keeps the task and its attempt", () => {
  beforeEach(() => { process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "50"; process.env.LANE_PILOT_POLL_SCALE = "0.001"; });
  afterEach(() => { delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS; delete process.env.LANE_PILOT_POLL_SCALE; });

  it("holds a queued task on its attempt and goes on with the same attempt when it is released", async () => {
    const { db, harness, dispatch, tool, releaseBase } = await setup();
    const first = await dispatch();
    expect(await tool("lane_pilot_queue", { action:"hold", taskIds:["replan-me"] })).toMatchObject({ tasks:["replan-me"] });
    releaseBase();
    await until(() => String(listStageReceipts(db, runId, "replan-me").find((row) => row.stageId === "writer-agent")?.reason).includes("held"));
    expect(getAttempt(db, String(first.attemptId))).toMatchObject({ state:"queued", thread_id:null });
    expect(listStageReceipts(db, runId, "replan-me").find((row) => row.stageId === "writer-agent")?.reason).toContain("held");
    await tool("lane_pilot_queue", { action:"release", taskIds:["replan-me"] });
    await until(() => getAttempt(db, String(first.attemptId))?.state !== "queued");
    expect(getAttempt(db, String(first.attemptId))?.state).not.toBe("queued");
    expect(listAttemptsForTask(db, runId, "replan-me").map((row) => row.id)).toEqual([first.attemptId]);
    expect(taskCount(db)).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("gives the same task and attempt back to the same contract sent again after a cancel of its queued attempt", async () => {
    const { db, harness, dispatch, tool, releaseBase } = await setup();
    const first = await dispatch();
    expect(await tool("lane_pilot_queue", { action:"hold", taskIds:["replan-me"] })).toMatchObject({ tasks:["replan-me"] });
    releaseBase();
    await until(() => String(listStageReceipts(db, runId, "replan-me").find((row) => row.stageId === "writer-agent")?.reason).includes("held"));
    const canceled = await tool("lane_pilot_cancel_task", { taskIds:["replan-me"] });
    expect(canceled).toMatchObject({ results:[{ taskId:"replan-me", state:"canceled" }] });
    expect(getAttempt(db, String(first.attemptId))?.state).toBe("canceled");

    const again = await dispatch();
    expect(again).toMatchObject({ taskId:"replan-me", attemptId:first.attemptId, state:"queued", reused:true });
    expect(taskCount(db)).toBe(1);
    expect(listAttemptsForTask(db, runId, "replan-me")).toHaveLength(1);
    expect(getAttempt(db, String(first.attemptId))).toMatchObject({ state:"queued", thread_id:null });
    expect(listStageReceipts(db, runId, "replan-me").filter((row) => ["writer-agent", "verification", "acceptance-receipt"].includes(row.stageId)).map((row) => row.state)).toEqual(["pending", "pending", "pending"]);

    // The task is still held, so the revived attempt waits; released, it goes on as the same attempt.
    await tool("lane_pilot_queue", { action:"release", taskIds:["replan-me"] });
    await until(() => getAttempt(db, String(first.attemptId))?.state !== "queued");
    expect(getAttempt(db, String(first.attemptId))?.state).not.toBe("queued");
    expect(listAttemptsForTask(db, runId, "replan-me")).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("says when a hold cannot stop the task because its writer already works", async () => {
    const { db, harness, dispatch, tool, releaseBase } = await setup();
    const first = await dispatch();
    releaseBase();
    db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='writer-revive' WHERE id=?").run(String(first.attemptId));
    expect(await tool("lane_pilot_queue", { action:"hold", taskIds:["replan-me"] })).toMatchObject({ tasks:["replan-me"], notHeld:["replan-me"] });
    await harness.lifecycle.dispose();
  });

  it("sends a changed contract as a new task, as before", async () => {
    const { db, harness, dispatch, tool, releaseBase } = await setup();
    await dispatch();
    await tool("lane_pilot_queue", { action:"hold", taskIds:["replan-me"] });
    releaseBase();
    await until(() => String(listStageReceipts(db, runId, "replan-me").find((row) => row.stageId === "writer-agent")?.reason).includes("held"));
    await tool("lane_pilot_cancel_task", { taskIds:["replan-me"] });
    const changed = await dispatch({ objective:"create hello and goodbye" });
    expect(changed.reused).toBeUndefined();
    expect(changed).toMatchObject({ taskId:"replan-me.2" });
    expect(taskCount(db)).toBe(2);
    await harness.lifecycle.dispose();
  });
});
