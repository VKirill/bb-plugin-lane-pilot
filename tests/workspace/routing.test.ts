import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { parseWorkspaceMode, resolveAttemptWorkspace, resolveManagedWorkspace, usesManagedWorktree } from "../../src/workspace/routing";
import plugin from "../../server";
import { getRun, openDatabase, saveProjectSetting, savePrototypeConfig } from "../../src/database";

describe("workspace routing", () => {
  it("defaults to auto and defers isolation until task risk is available", () => {
    expect(parseWorkspaceMode(undefined)).toBe("auto");
    expect(usesManagedWorktree(parseWorkspaceMode("auto"))).toBe(false);
    expect(usesManagedWorktree(parseWorkspaceMode("worktree"))).toBe(true);
    expect(usesManagedWorktree(parseWorkspaceMode("in_place"))).toBe(false);
    expect(() => parseWorkspaceMode("maybe")).toThrow(/workspace.mode/);
  });

  it("accepts only a ready managed worktree on the requested host", () => {
    const row = { id:"env-1", hostId:"host-1", status:"ready", managed:true,
      workspaceProvisionType:"managed-worktree", path:"/workspaces/project-1" };
    expect(resolveManagedWorkspace(row, "host-1")).toEqual({ environmentId:"env-1", hostId:"host-1", path:"/workspaces/project-1" });
    expect(() => resolveManagedWorkspace({ ...row, status:"creating" }, "host-1")).toThrow(/not ready/);
    expect(() => resolveManagedWorkspace(row, "host-2")).toThrow(/host mismatch/);
    expect(() => resolveManagedWorkspace({ ...row, managed:false }, "host-1")).toThrow(/not a managed worktree/);
    expect(() => resolveManagedWorkspace({ ...row, path:null }, "host-1")).toThrow(/absolute path/);
  });

  it("routes auto work by validated risk score and multi-write policy, preserving explicit modes", () => {
    expect(resolveAttemptWorkspace({mode:"auto",risk:"high",expectedOutputCount:1,minScore:4,multiWriteEnabled:true}))
      .toMatchObject({score:8,strategy:"provision_attempt_worktree",reason:"risk_threshold"});
    expect(resolveAttemptWorkspace({mode:"auto",risk:"low",expectedOutputCount:2,minScore:4,multiWriteEnabled:true}))
      .toMatchObject({score:2,multiWrite:true,strategy:"provision_attempt_worktree",reason:"multi_write"});
    expect(resolveAttemptWorkspace({mode:"auto",risk:"low",expectedOutputCount:2,minScore:4,multiWriteEnabled:false}))
      .toMatchObject({strategy:"inherit_run",reason:"below_threshold"});
    expect(resolveAttemptWorkspace({mode:"in_place",risk:"critical",expectedOutputCount:4,minScore:4,multiWriteEnabled:true}))
      .toMatchObject({strategy:"inherit_run",reason:"explicit_in_place"});
    expect(resolveAttemptWorkspace({mode:"worktree",risk:"low",expectedOutputCount:1,minScore:9,multiWriteEnabled:false}))
      .toMatchObject({strategy:"inherit_run",reason:"explicit_worktree"});
    expect(()=>resolveAttemptWorkspace({mode:"auto",risk:"unknown",expectedOutputCount:1,minScore:4,multiWriteEnabled:true})).toThrow(/unsupported task risk/);
    expect(()=>resolveAttemptWorkspace({mode:"auto",risk:"low",expectedOutputCount:1,minScore:11,multiWriteEnabled:true})).toThrow(/0 to 10/);
  });

  it("activates auto PM on configured workspace and provisions only explicit worktree mode", async () => {
    const spawnInputs:Record<string,unknown>[] = [];
    const makeHost = (environmentStatus:string) => createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{
        threads:{
          getPluginMetadata:async () => ({ role:"user" }),
          spawn:async (args) => { spawnInputs.push(args as unknown as Record<string,unknown>); return { id:`pm-${environmentStatus}`, environmentId:`env-${environmentStatus}` } as never; },
          stop:async () => undefined,
          list:async () => [] as never,
        },
        environments:{ get:async () => ({ id:`env-${environmentStatus}`, hostId:"workspace-host", status:environmentStatus,
          managed:true, workspaceProvisionType:"managed-worktree", path:"/tmp/lane-managed-worktree" }) as never },
      },
      experimental_callHostRpc:(call) => {
        if (call.method === "detect") return { hostId:"workspace-host",laneStack:{present:true,version:"custom",sourceSha:"custom"},openCode:{present:false,version:null},workspace:{path:"/tmp/lane-pm",present:true},targetSha:"dd77",matchesTarget:false,scenario:"S1" };
        if (call.method === "coexistenceInventory") return { schemaVersion:1,hostId:"workspace-host",targetSha:"dd77",managers:[{
          manager:"agents-marker",path:"/home/test/.agents/install.json",installed:true,configured:true,loaded:null,
          compatible:true,modified:null,version:"custom",sourceSha:"custom",sha256:"a".repeat(64),owner:"user",decision:"reuse",
          capabilities:["threads.spawn"],missingCapabilities:[],evidence:[],
        }] };
        if (call.method === "importConfig") return { schemaVersion:1,action:"import-config",scenario:"S1",status:"ok",filesChanged:[],externalOpsBefore:{},externalOpsAfter:{},skippedExternalOps:[],warning:null,exitCode:0,receiptPath:null,snapshotPath:null,sourceSha:null,notes:[],imported:{routingProfile:null,nightShift:null} };
        if (call.method === "writePmSettings") return { hostId:"workspace-host",settingsPath:"/tmp/lane-pm/.claude/settings.json",guardPath:"/tmp/guard_shell.py" };
        throw new Error(`unexpected ${call.method}`);
      },
    });
    const config = { projectId:"workspace-project",hostId:"workspace-host",pmWorkspacePath:"/tmp/lane-pm",writerWorkspacePath:"/tmp/lane-base",
      pmProviderId:"codex",pmModel:"gpt-6-luna",writerProviderId:"codex",writerModel:"gpt-6-luna" };

    const ready = makeHost("ready");
    const db = openDatabase(ready.bb);
    savePrototypeConfig(db,config);
    saveProjectSetting(db,config.projectId,"adoc.040","auto");
    saveProjectSetting(db,config.projectId,"run.gate","pre-merge");
    await plugin(ready.bb);
    const activated = await ready.harness.behavior.callRpc("activate_pm",{ projectId:config.projectId,sourceThreadId:"source-thread" }) as {runId:string};
    expect(spawnInputs[0]?.environment).toEqual({ type:"host",hostId:"workspace-host",workspace:{ type:"unmanaged",path:"/tmp/lane-pm" } });
    expect(getRun(db,activated.runId)).toMatchObject({ writer_workspace_path:"/tmp/lane-base",writer_environment_id:null,run_gate:"pre-merge",state:"running" });
    await ready.harness.lifecycle.dispose();

    const explicit = makeHost("ready");
    const explicitDb = openDatabase(explicit.bb);
    savePrototypeConfig(explicitDb,config);
    saveProjectSetting(explicitDb,config.projectId,"adoc.040","worktree");
    await plugin(explicit.bb);
    const explicitRun = await explicit.harness.behavior.callRpc("activate_pm",{ projectId:config.projectId,sourceThreadId:"source-thread" }) as {runId:string};
    expect(spawnInputs[1]?.environment).toEqual({ type:"host",hostId:"workspace-host",workspace:{ type:"managed-worktree",baseBranch:{ kind:"default" } } });
    expect(getRun(explicitDb,explicitRun.runId)).toMatchObject({ writer_workspace_path:"/tmp/lane-managed-worktree",writer_environment_id:"env-ready",state:"running" });
    await explicit.harness.lifecycle.dispose();

    const incomplete = makeHost("creating");
    const failedDb = openDatabase(incomplete.bb);
    savePrototypeConfig(failedDb,config);
    saveProjectSetting(failedDb,config.projectId,"adoc.040","worktree");
    await plugin(incomplete.bb);
    await expect(incomplete.harness.behavior.callRpc("activate_pm",{ projectId:config.projectId,sourceThreadId:"source-thread" }))
      .rejects.toThrow(/managed worktree.*not ready/);
    expect(failedDb.prepare("SELECT state,writer_workspace_path,writer_environment_id FROM lane_pilot_run").get())
      .toMatchObject({ state:"blocked",writer_workspace_path:null,writer_environment_id:null });
    expect(failedDb.prepare("SELECT COUNT(*) AS count FROM lane_pilot_activation").get()).toEqual({ count:0 });
    await incomplete.harness.lifecycle.dispose();
  });
});
