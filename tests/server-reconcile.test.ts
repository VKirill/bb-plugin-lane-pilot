import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import {
  createAttempt,
  createRun,
  createTask,
  claimActivation,
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
  it("defaults the global locale preference to auto and honors explicit overrides", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    await plugin(bb);
    expect(await harness.behavior.callRpc("get_preferences", { suggestedLocale:"ru" })).toMatchObject({ locale:"ru", preference:"auto" });
    expect(await harness.behavior.callRpc("set_locale", { locale:"en", suggestedLocale:"ru" })).toMatchObject({ locale:"en", preference:"en" });
    expect(await harness.behavior.callRpc("get_preferences", { suggestedLocale:"ru" })).toMatchObject({ locale:"en", preference:"en" });
    expect(await harness.behavior.callRpc("set_locale", { locale:"auto", suggestedLocale:"ru" })).toMatchObject({ locale:"ru", preference:"auto" });
    expect(await harness.behavior.callRpc("get_preferences", { suggestedLocale:"en" })).toMatchObject({ locale:"en", preference:"auto" });
    await harness.lifecycle.dispose();
  });

  it("finishes an idle project run through CLI and allows another activation", async () => {
    const stopped: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{ threads:{
        stop: async ({ threadId }) => { stopped.push(threadId); },
        get: async () => ({ status:"idle" }) as never,
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
    expect(db.prepare("SELECT state,closed_at,closed_by FROM lane_pilot_run WHERE id='run-before-finish'").get()).toMatchObject({ state:"closed", closed_by:"cli" });

    const next = await harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId:"source-thread" }) as {threadId:string;runId:string};
    expect(next).toMatchObject({ threadId:"pm-after-finish", runId:expect.any(String) });
    expect((db.prepare("SELECT state FROM lane_pilot_run WHERE id=?").get(next.runId) as {state:string}).state).toBe("running");
    await harness.behavior.runCli(["finish", projectId]);
    await harness.lifecycle.dispose();
  });

  it("rejects RPC and CLI finish while a writer attempt is open and keeps activation claimed", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{
      stop: async () => undefined,
      get: async () => ({ status:"idle" }) as never,
      listRunning: async () => [],
    } } });
    const db = openDatabase(bb);
    createRun(db, "run-open-attempt", projectId);
    setRunThread(db, "run-open-attempt", pmThreadId);
    createTask(db, { id:"task-open-attempt", runId:"run-open-attempt", kind:"bb", contract:{} });
    createAttempt(db, { id:"attempt-open", runId:"run-open-attempt", taskId:"task-open-attempt" });
    claimActivation(db, { projectId, pmThreadId, runId:"run-open-attempt" });
    await plugin(bb);

    await expect(harness.behavior.callRpc("finish_run", { projectId, runId:"run-open-attempt" }))
      .rejects.toThrow(/running attempts remain/);
    const cli = await harness.behavior.runCli(["finish", projectId, "run-open-attempt"]);
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr).toMatch(/running attempts remain/);
    expect((db.prepare("SELECT state,closed_at FROM lane_pilot_run WHERE id='run-open-attempt'").get() as {state:string;closed_at:number|null}))
      .toEqual({ state:"running", closed_at:null });
    expect(db.prepare("SELECT run_id FROM lane_pilot_activation WHERE project_id=?").get(projectId)).toEqual({ run_id:"run-open-attempt" });
    await harness.lifecycle.dispose();
  });

  it("fails closed when PM stop, status observation, or running-list observation fails", async () => {
    const faults: Array<{ name:string; threads: Record<string, unknown> }> = [
      { name:"stop rejected", threads:{ stop:async () => { throw new Error("stop unavailable"); }, get:async () => ({ status:"idle" }), listRunning:async () => [] } },
      { name:"get rejected", threads:{ stop:async () => undefined, get:async () => { throw new Error("get unavailable"); }, listRunning:async () => [] } },
      { name:"listRunning unavailable", threads:{ stop:async () => undefined, get:async () => ({ status:"idle" }), listRunning:undefined } },
    ];
    for (const fault of faults) {
      const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:fault.threads as never } });
      const db = openDatabase(bb);
      const runId = `run-${fault.name}`;
      createRun(db, runId, projectId);
      setRunThread(db, runId, pmThreadId);
      claimActivation(db, { projectId, pmThreadId, runId });
      await plugin(bb);
      const cli = await harness.behavior.runCli(["finish", projectId, runId]);
      expect(cli.exitCode, fault.name).toBe(1);
      expect((db.prepare("SELECT state,closed_at FROM lane_pilot_run WHERE id=?").get(runId) as {state:string;closed_at:number|null}))
        .toMatchObject({ state:"running", closed_at:null });
      expect(db.prepare("SELECT run_id FROM lane_pilot_activation WHERE project_id=?").get(projectId)).toEqual({ run_id:runId });
      await harness.lifecycle.dispose();
    }
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
    createRun(db, "run-live", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-live", pmThreadId);
    await plugin(bb);

    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true },
      { threadId:pmThreadId, projectId },
    )));
    const waiting = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_wait_writer",
      { runId:dispatched.runId, timeoutSec:1 },
      { threadId:pmThreadId, projectId },
    )));
    expect(waiting.state).toBe("running");

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
