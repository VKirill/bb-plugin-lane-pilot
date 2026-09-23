import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import {
  createAttempt,
  createRun,
  getAttempt,
  openDatabase,
  savePrototypeConfig,
  setRunThread,
  transitionAttempt,
} from "../src/database";
import { TARGET_SHA } from "../src/constants";

const projectId = "project-test";
const pmThreadId = "pm-thread";
const config = {
  projectId,
  hostId:"host-test",
  pmWorkspacePath:"/tmp/pm",
  writerWorkspacePath:"/tmp/writer",
  pmProviderId:"claude-code",
  pmModel:"claude-test",
  writerProviderId:"codex",
  writerModel:"codex-test",
};

describe("production spawn_unknown reconciliation", () => {
  it("finishes an idle project run through CLI and allows another activation", async () => {
    const stopped: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{ threads:{
        stop: async ({ threadId }) => { stopped.push(threadId); },
        get: async () => ({ status:"completed" }) as never,
        listRunning: async () => [],
        getPluginMetadata: async () => ({}),
        spawn: async () => ({ id:"pm-after-finish" }) as never,
      } },
      experimental_callHostRpc: (call) => {
        if (call.method === "detect") return { hostId:"host-test", laneStack:{ present:true,version:"1.38.0",sourceSha:TARGET_SHA },openCode:{present:false,version:null},workspace:{path:"/tmp/pm",present:true},targetSha:TARGET_SHA,matchesTarget:true,scenario:"S1" };
        if (call.method === "importConfig") return { schemaVersion:1,action:"import-config",scenario:"S7",status:"ok",filesChanged:[],externalOpsBefore:{},externalOpsAfter:{},skippedExternalOps:[],warning:null,exitCode:0,receiptPath:null,snapshotPath:null,sourceSha:null,notes:[],imported:{routingProfile:null,nightShift:null} };
        if (call.method === "writePmSettings") return { hostId:"host-test",settingsPath:"/tmp/pm/.claude/settings.json",guardPath:"/tmp/guard_shell.py" };
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-before-finish", projectId);
    setRunThread(db, "run-before-finish", "pm-before-finish");
    await plugin(bb);

    const finish = await harness.behavior.runCli(["finish", projectId]);
    expect(finish.exitCode).toBe(0);
    expect(JSON.parse(finish.stdout)).toMatchObject({ projectId, closed:true, finishedRunIds:["run-before-finish"] });
    expect(stopped).toEqual(["pm-before-finish"]);
    expect((db.prepare("SELECT closed_at FROM lane_pilot_run WHERE id='run-before-finish'").get() as {closed_at:number|null}).closed_at).not.toBeNull();

    const next = await harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId:"source-thread" }) as {threadId:string;runId:string};
    expect(next).toMatchObject({ threadId:"pm-after-finish", runId:expect.any(String) });
    expect((db.prepare("SELECT state FROM lane_pilot_run WHERE id=?").get(next.runId) as {state:string}).state).toBe("running");
    await harness.behavior.runCli(["finish", projectId]);
    await harness.lifecycle.dispose();
  });

  it("reconciles by metadata after the spawn response is lost and continues with the found thread", async () => {
    let capturedMetadata: Record<string,unknown> | undefined;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-live" }
            : capturedMetadata ?? {},
          spawn: async (args) => {
            capturedMetadata = args.pluginMetadata as Record<string,unknown>;
            throw Object.assign(new Error("synthetic response timeout"), { code:"ETIMEDOUT" });
          },
          list: async () => [{ id:"writer-existing" }] as never,
          wait: async () => { throw new Error("wait sentinel after reconcile"); },
          get: async () => ({ id:"writer-existing", status:"active" }) as never,
        },
      },
      experimental_callHostRpc: (call) => {
        if (call.method === "runCommand") {
          return { hostId:"host-test", exitCode:0, stdout:"[]", stderr:"" };
        }
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, "run-live", projectId);
    setRunThread(db, "run-live", pmThreadId);
    await plugin(bb);

    await expect(harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true },
      { threadId:pmThreadId, projectId },
    )).rejects.toThrow("wait sentinel after reconcile");

    const row = db.prepare("SELECT thread_id,state FROM lane_pilot_attempt WHERE run_id='run-live'").get() as
      {thread_id:string|null; state:string};
    expect(row).toEqual({ thread_id:"writer-existing", state:"running" });
    expect(capturedMetadata).toMatchObject({
      role:"writer",
      lanePilotRunId:"run-live",
      lanePilotTaskId:expect.any(String),
      attemptId:expect.any(String),
    });
    await harness.lifecycle.dispose();
  });

  it("recovery without thread_id searches the complete list by the persisted triple", async () => {
    const triple = { lanePilotRunId:"run-recover", lanePilotTaskId:"task-recover", attemptId:"attempt-recover" };
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          list: async () => [{ id:"writer-found" }] as never,
          getPluginMetadata: async () => triple,
          get: async () => ({ id:"writer-found", status:"active" }) as never,
        },
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    createRun(db, triple.lanePilotRunId, projectId);
    setRunThread(db, triple.lanePilotRunId, pmThreadId);
    createAttempt(db, { id:triple.attemptId, runId:triple.lanePilotRunId, taskId:triple.lanePilotTaskId });
    transitionAttempt(db, triple.attemptId, "spawn_unknown", { reason:"response lost" });
    expect(getAttempt(db, triple.attemptId)?.thread_id).toBeNull();
    await plugin(bb);

    const result = await harness.behavior.runCli(["recover", triple.attemptId]);
    expect(result).toMatchObject({ exitCode:1, stderr:"writer is not idle: active" });
    expect(getAttempt(db, triple.attemptId)).toMatchObject({ thread_id:"writer-found", state:"running" });
    await harness.lifecycle.dispose();
  });
});
