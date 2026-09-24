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
  saveProjectSetting,
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
  it("routes confirmed install and OpenCode connect through typed coexistence operations", async () => {
    const hostCalls: Array<{ method:string; input:Record<string, unknown> }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      experimental_callHostRpc: (call) => {
        hostCalls.push({ method:call.method, input:call.input as Record<string, unknown> });
        if (call.method === "coexistenceInventory") return {
          schemaVersion:1, hostId:"host-test", targetSha:TARGET_SHA,
          managers:[
            { manager:"managed-checkout",path:"/home/test/.agents/lane-pilot/engines/dd77",installed:true,configured:false,loaded:null,compatible:true,modified:true,version:"custom",sourceSha:"newer-sha",sha256:"a".repeat(64),owner:"user",decision:"reuse",capabilities:["threads.spawn"],missingCapabilities:[],evidence:[] },
            { manager:"opencode-config",path:"/home/test/.config/opencode/opencode.json",installed:true,configured:false,loaded:null,compatible:null,modified:null,version:null,sourceSha:null,sha256:"b".repeat(64),owner:"user",decision:"skip",capabilities:[],missingCapabilities:[],evidence:[] },
            { manager:"opencode-plugin",path:"/home/test/.config/opencode/plugins/opencode-lane.ts",installed:true,configured:false,loaded:null,compatible:true,modified:null,version:null,sourceSha:"newer-sha",sha256:"c".repeat(64),owner:"lane-pilot",decision:"reuse",capabilities:["opencode.module"],missingCapabilities:[],evidence:[] },
          ],
        };
        if (call.method === "coexistenceOperation") {
          const input = call.input as Record<string, unknown>;
          return { schemaVersion:1,hostId:"host-test",operation:input.operation,manager:input.manager,path:input.path,status:input.operation === "rollback" ? "rolled_back" : input.manager === "opencode-config" ? "ok" : "skipped",beforeSha256:input.expectedSha256,afterSha256:input.expectedSha256,snapshotId:typeof input.snapshotId === "string" ? input.snapshotId : input.manager === "opencode-config" ? "snapshot-connect-123" : null,owner:"lane-pilot",evidence:[],reason:null };
        }
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    await plugin(bb);

    const install = await harness.behavior.callRpc("stack_install", { projectId, confirmExternalOps:true });
    expect(install).toMatchObject({ operation:"install", manager:"managed-checkout", status:"skipped" });
    expect(hostCalls.map((call) => call.method)).toEqual(["coexistenceInventory", "coexistenceOperation"]);
    expect(hostCalls[1]?.input).toMatchObject({ operation:"install", manager:"managed-checkout", expectedSha256:"a".repeat(64) });

    hostCalls.length = 0;
    const connect = await harness.behavior.callRpc("stack_connect", { projectId, confirmExternalOps:true });
    expect(connect).toMatchObject({ action:"connect", status:"ok", coexistenceOperations:[
      { manager:"opencode-plugin",operation:"install",status:"skipped" },
      { manager:"opencode-config",operation:"connect",status:"ok",snapshotId:"snapshot-connect-123" },
    ] });
    expect(hostCalls.map((call) => call.method)).toEqual([
      "coexistenceInventory", "coexistenceOperation", "coexistenceInventory", "coexistenceOperation",
    ]);
    expect(hostCalls.at(-1)?.input).toMatchObject({ operation:"connect", manager:"opencode-config", expectedSha256:"b".repeat(64) });

    hostCalls.length = 0;
    const rollback = await harness.behavior.callRpc("stack_rollback", { projectId });
    expect(rollback).toMatchObject({ action:"rollback", status:"rolled_back", results:[
      { operation:"rollback", manager:"opencode-config", snapshotId:"snapshot-connect-123", status:"rolled_back" },
    ] });
    expect(hostCalls.map((call) => call.method)).toEqual(["coexistenceInventory", "coexistenceOperation"]);
    expect(hostCalls.at(-1)?.input).toMatchObject({ operation:"rollback", manager:"opencode-config", snapshotId:"snapshot-connect-123", expectedSha256:"b".repeat(64) });
    await harness.lifecycle.dispose();
  });

  it("reports exact missing capability and refuses activation without an install fallback", async () => {
    const calls:string[] = [];
    let spawned = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{ threads:{
        getPluginMetadata:async () => ({ role:"user" }),
        spawn:async () => { spawned += 1; return { id:"unexpected-pm" } as never; },
      } },
      experimental_callHostRpc:(call) => {
        calls.push(call.method);
        if (call.method === "detect") return { hostId:"host-test",laneStack:{present:true,version:"newer",sourceSha:"custom"},openCode:{present:true,version:"1.2"},workspace:{path:"/tmp/pm",present:true},targetSha:TARGET_SHA,matchesTarget:false,scenario:"S2" };
        if (call.method === "coexistenceInventory") return { schemaVersion:1,hostId:"host-test",targetSha:TARGET_SHA,managers:[{
          manager:"agents-marker",path:"/home/test/.agents/install.json",installed:true,configured:true,loaded:null,compatible:false,modified:null,
          version:"custom",sourceSha:"custom",sha256:"a".repeat(64),owner:"user",decision:"conflict",capabilities:[],missingCapabilities:["threads.spawn"],
          evidence:[{kind:"capability",path:"/home/test/.agents/install.json",sha256:null,detail:"Required interface threads.spawn is missing from capability set."}],
        }] };
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    await plugin(bb);
    await expect(harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId:"source-thread" }))
      .rejects.toThrow(/threads\.spawn/);
    expect(calls).toEqual(["detect", "coexistenceInventory"]);
    expect(spawned).toBe(0);
    await harness.lifecycle.dispose();
  });

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
        if (call.method === "detect") return { hostId:"host-test", laneStack:{ present:true,version:"1.39.0",sourceSha:"custom-newer-sha" },openCode:{present:false,version:null},workspace:{path:"/tmp/pm",present:true},targetSha:TARGET_SHA,matchesTarget:false,scenario:"S2" };
        if (call.method === "coexistenceInventory") return { schemaVersion:1,hostId:"host-test",targetSha:TARGET_SHA,managers:[{
          manager:"agents-marker",path:"/home/test/.agents/install.json",installed:true,configured:true,loaded:null,
          compatible:true,modified:null,version:"custom",sourceSha:"custom-newer-sha",sha256:"a".repeat(64),
          owner:"user",decision:"reuse",capabilities:["threads.spawn"],missingCapabilities:[],evidence:[{kind:"capability",path:"/home/test/.agents/install.json",sha256:null,detail:"threads.spawn is available"}],
        }] };
        if (call.method === "importConfig") return { schemaVersion:1,action:"import-config",scenario:"S7",status:"ok",filesChanged:[],externalOpsBefore:{},externalOpsAfter:{},skippedExternalOps:[],warning:null,exitCode:0,receiptPath:null,snapshotPath:null,sourceSha:null,notes:[],imported:{routingProfile:null,nightShift:null} };
        if (call.method === "writePmSettings") return { hostId:"host-test",settingsPath:"/tmp/pm/.claude/settings.json",guardPath:"/tmp/guard_shell.py" };
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "adoc.040", "in_place");
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
    let capturedWriterEnvironment: unknown;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
            ? { role:"pm", lanePilotRunId:"run-live" }
            : capturedMetadata ?? {},
          spawn: async (args) => {
            const metadata=args.pluginMetadata as Record<string,unknown>;
            if(metadata.role==="workspace-provisioner") return {id:"workspace-holder",environmentId:"reconcile-env"};
            capturedWriterEnvironment=args.environment;
            capturedMetadata = args.pluginMetadata as Record<string,unknown>;
            throw Object.assign(new Error("synthetic response timeout"), { code:"ETIMEDOUT" });
          },
          list: async () => [{ id:"writer-existing" }] as never,
          wait: async () => { throw new Error("wait sentinel after reconcile"); },
          get: async ({threadId}) => ({ id:threadId, status:threadId==="workspace-holder"?"idle":"active" }) as never,
          stop: async () => ({ok:true}) as never,
        },
        environments:{get:async ({environmentId})=>({id:environmentId,hostId:"host-test",path:environmentId==="reconcile-env"?"/tmp/reconciled-attempt-worktree":config.writerWorkspacePath,status:"ready",managed:true,workspaceProvisionType:"managed-worktree"}) as never},
        providers:{
          list:async () => [{ id:"codex", available:true, capabilities:{ supportsServiceTier:false }, serviceTiers:[] }] as never,
          models:async () => ({ models:[{ id:"codex-test", model:"codex-test", supportedReasoningEfforts:["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })) }] as never }),
        },
        files:{ read:async ({path})=>path.endsWith("README.md")?{content:"reconciliation task fixture\n"}:{content:null} },
      },
      experimental_callHostRpc: (call) => {
        if(call.method==="gitOwnershipBase") return {hostId:"host-test",status:"not-git",branch:null,headSha:null,baseRef:null,baseSha:null,compareCommitted:false,reason:"synthetic fixture is not a git worktree"};
        if (call.method === "runCommand") {
          return { hostId:"host-test", exitCode:0, stdout:"[]", stderr:"" };
        }
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "plan_critique.enabled", false);
    saveProjectSetting(db, projectId, "jev.LANE_JEV_EFFORT", false);
    createRun(db, "run-live", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-live", pmThreadId);
    await plugin(bb);

    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_dispatch_writer",
      { confirm:true, plan:"Canonical live reconciliation plan" },
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
    expect(db.prepare("SELECT workspace_path,environment_id FROM lane_pilot_attempt WHERE run_id='run-live'").get())
      .toEqual({workspace_path:"/tmp/reconciled-attempt-worktree",environment_id:"reconcile-env"});
    expect(capturedWriterEnvironment).toEqual({type:"reuse",environmentId:"reconcile-env"});
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

  it("keeps spawn_unknown fail-closed on transient inventory failure and reconciles without respawn later", async () => {
    const triple = { lanePilotRunId:"run-transient-reconcile", lanePilotTaskId:"task-transient-reconcile", attemptId:"attempt-transient-reconcile" };
    let inventoryAvailable=false;
    let writerSpawns=0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{threads:{
        list:async () => {
          if(!inventoryAvailable)throw new Error("thread inventory temporarily unavailable");
          return [{id:"writer-found-after-retry"}] as never;
        },
        getPluginMetadata:async () => triple,
        get:async ({threadId})=>({id:threadId,status:"active"}) as never,
        spawn:async () => {writerSpawns+=1;return {id:"unexpected-respawn"} as never;},
      }},
    });
    const db=openDatabase(bb);
    savePrototypeConfig(db,config);
    createRun(db,triple.lanePilotRunId,projectId);
    setRunThread(db,triple.lanePilotRunId,pmThreadId);
    createTask(db,{id:triple.lanePilotTaskId,runId:triple.lanePilotRunId,kind:"bb",contract:{}});
    createAttempt(db,{id:triple.attemptId,runId:triple.lanePilotRunId,taskId:triple.lanePilotTaskId});
    transitionAttempt(db,triple.attemptId,"spawn_unknown",{reason:"provider response was lost"});
    await plugin(bb);

    expect(getAttempt(db,triple.attemptId)).toMatchObject({state:"spawn_unknown",thread_id:null});
    expect(writerSpawns).toBe(0);
    inventoryAvailable=true;
    const resumed=await harness.behavior.callRpc("resume_runs",{projectId});
    expect(resumed).toMatchObject({resumed:[triple.attemptId],skipped:[],finished:[]});
    expect(getAttempt(db,triple.attemptId)).toMatchObject({state:"running",thread_id:"writer-found-after-retry"});
    expect(writerSpawns).toBe(0);
    await harness.lifecycle.dispose();
  });
});
