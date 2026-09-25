import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { appendGateEvaluation, casSetting, claimDailySchedule, claimDocsSpawn, claimStageSpawn, closeRun, createAttempt, createRun, createTask, freezeRunBinding, getAttempt, getRunWriterHost, getTaskGitBase, importSettingsOnce, listGateEvents, listStageEvents, listStageReceipts, migrations, openDatabase, saveStageReceipt, saveTaskGitBase, setAttemptHolderThread, setAttemptWorkspace, setRunWorkspace, getRun, setRunThread, transitionAttempt } from "../src/database";

describe("section 9 storage.database DDL", () => {
  it("migrates an existing populated database without losing rows and expands the run state check", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations.slice(0, 9));
    db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,created_at,updated_at,kind,closed_at) VALUES ('old-run','A','running',1,2,'bb',NULL)").run();
    db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,created_at,updated_at,kind,closed_at) VALUES ('legacy-closed','A','running',2,3,'bb',3)").run();
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES ('old-task','old-run','bb','{}',1)").run();
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,created_at,updated_at,attempt_no,dirt_before_json) VALUES ('old-attempt','old-run','old-task','accepted',1,2,1,'[]')").run();
    openDatabase(bb);
    const runSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='lane_pilot_run'").get() as {sql:string};
    expect(runSchema.sql).toContain("'closed'");
    expect(db.prepare("SELECT id,state,closed_at,closed_by FROM lane_pilot_run WHERE id='old-run'").get()).toEqual({ id:"old-run", state:"running", closed_at:null, closed_by:null });
    expect(db.prepare("SELECT state,closed_at,closed_by FROM lane_pilot_run WHERE id='legacy-closed'").get()).toEqual({ state:"closed", closed_at:3, closed_by:"legacy" });
    expect((db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE id='old-attempt'").get() as {count:number}).count).toBe(1);
    createRun(db, "new-run", "A");
    createTask(db, { id:"new-task", runId:"new-run", kind:"bb", contract:{} });
    expect(saveTaskGitBase(db,"new-task",{baseRef:"main",baseSha:"a".repeat(40),initialHeadSha:"b".repeat(40),branch:"feature",compareCommitted:true})).toBe(true);
    expect(saveTaskGitBase(db,"new-task",{baseRef:null,baseSha:null,initialHeadSha:"b".repeat(40),branch:"main",compareCommitted:false})).toBe(false);
    expect(getTaskGitBase(db,"new-task")).toMatchObject({base_ref:"main",base_sha:"a".repeat(40),initial_head_sha:"b".repeat(40),branch:"feature",compare_committed:true});
    createAttempt(db, { id:"new-attempt", runId:"new-run", taskId:"new-task" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("UPDATE lane_pilot_run SET state='closed' WHERE id='old-run'").run();
    await harness.lifecycle.dispose();
  });

  it("covers DDL, PK isolation, CAS and project isolation", async () => {
    const {bb,harness} = createFakePluginHost({pluginId:"lane-pilot"});
    const db = openDatabase(bb);
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='lane_pilot_project_settings'").get() as {sql:string};
    expect(schema.sql).toContain("PRIMARY KEY (project_id, binding_id, key)");
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,key,value,updated_at) VALUES (?,?,?,?)")
      .run("A", "writer.provider", '"codex"', 1);
    expect(() => db.prepare("INSERT INTO lane_pilot_project_settings(project_id,key,value,updated_at) VALUES (?,?,?,?)")
      .run("A", "writer.provider", '"kimi"', 2)).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,updated_at) VALUES (?,?,?,?,?)")
      .run("A", "binding_1", "writer.provider", '"kimi"', 3);
    expect(casSetting(db,{projectId:"A",key:"writer.provider",value:"agy",expectedVersion:1})).toBe(true);
    expect(casSetting(db,{projectId:"A",key:"writer.provider",value:"grok",expectedVersion:1})).toBe(false);
    expect((db.prepare("SELECT COUNT(*) count FROM lane_pilot_project_settings WHERE project_id='B'").get() as {count:number}).count).toBe(0);
    const winners = [2,2].map((version) => casSetting(db,{projectId:"A",key:"writer.provider",value:"race",expectedVersion:version}));
    expect(winners.filter(Boolean)).toHaveLength(1);
    const payload = {
      routingProfile: { path: "/tmp/r.yaml", text: "a: 1\n", sha256: "aa" },
      nightShift: { path: "/tmp/n.yaml", text: "b: 2\n", sha256: "bb" },
    };
    expect(importSettingsOnce(db, "A", payload).imported).toBe(true);
    expect(importSettingsOnce(db, "A", payload).imported).toBe(false);
    createRun(db, "run-close", "A");
    expect(closeRun(db, "run-close", "cli")).toBe(true);
    expect(closeRun(db, "run-close", "cli")).toBe(true);
    expect((db.prepare("SELECT state,closed_at,closed_by FROM lane_pilot_run WHERE id='run-close'").get() as {state:string;closed_at:number|null;closed_by:string|null})).toMatchObject({ state:"closed", closed_by:"cli" });
    createRun(db, "run-open", "A");
    createTask(db, { id:"task-open", runId:"run-open", kind:"bb", contract:{} });
    createAttempt(db, { id:"attempt-open", runId:"run-open", taskId:"task-open" });
    expect(closeRun(db, "run-open", "rpc")).toBe(false);
    expect((db.prepare("SELECT closed_at FROM lane_pilot_run WHERE id='run-open'").get() as {closed_at:number|null}).closed_at).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("persists and reads versioned stage receipts with run/task ownership", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "stage-run", "A");
    createTask(db, { id:"stage-task", runId:"stage-run", kind:"bb", contract:{} });
    saveStageReceipt(db, {
      contractVersion:1, runId:"stage-run", taskId:"stage-task", stageId:"plan-critique", state:"passed",
      inputSha256:"a".repeat(64), outputSha256:"b".repeat(64), attempt:1,
      providerId:"codex", model:"gpt-6-luna", threadId:"critic-thread",
      result:{ decision:"approve" }, reason:null, updatedAt:10,
    });
    expect(listStageReceipts(db, "stage-run", "stage-task")).toMatchObject([
      { contractVersion:1, stageId:"plan-critique", state:"passed", result:{ decision:"approve" } },
    ]);
    expect(listStageEvents(db,{projectId:"A",since:0})).toMatchObject([
      {runId:"stage-run",taskId:"stage-task",stageId:"plan-critique",state:"passed",inputSha256:"a".repeat(64)},
    ]);
    saveStageReceipt(db, {
      contractVersion:1, runId:"stage-run", taskId:"stage-task", stageId:"plan-critique", state:"passed",
      inputSha256:"a".repeat(64), outputSha256:"b".repeat(64), attempt:1,
      providerId:"codex", model:"gpt-6-luna", threadId:"critic-thread",
      result:{ decision:"approve", detail:"sensitive data stays out of event history" }, reason:null, updatedAt:11,
    });
    expect(listStageEvents(db,{projectId:"A",since:0})).toHaveLength(1);
    saveStageReceipt(db, {
      contractVersion:1, runId:"stage-run", taskId:"stage-task", stageId:"plan-critique", state:"failed",
      inputSha256:"a".repeat(64), outputSha256:null, attempt:1,
      providerId:"codex", model:"gpt-6-luna", threadId:"critic-thread",
      result:{ detail:"must not be copied" }, reason:"provider_error", updatedAt:12,
    });
    expect(listStageEvents(db,{projectId:"A",since:0})).toHaveLength(2);
    expect(JSON.stringify(listStageEvents(db,{projectId:"A",since:0}))).not.toContain("must not be copied");
    expect(()=>db.prepare("UPDATE lane_pilot_stage_event SET state='passed' WHERE id=1").run()).toThrow("append-only");
    expect(()=>db.prepare("DELETE FROM lane_pilot_stage_event WHERE id=1").run()).toThrow("append-only");
    expect(() => saveStageReceipt(db, {
      contractVersion:1, runId:"stage-run", taskId:"missing-task", stageId:"writer-agent", state:"pending",
      inputSha256:"a".repeat(64), outputSha256:null, attempt:0,
      providerId:null, model:null, threadId:null, result:null, reason:null, updatedAt:11,
    })).toThrow();
    await harness.lifecycle.dispose();
  });

  it("rolls back the latest receipt if the append-only event write fails", async () => {
    const {bb,harness}=createFakePluginHost({pluginId:"lane-pilot"});
    const db=openDatabase(bb);
    createRun(db,"event-fault-run","A");
    createTask(db,{id:"event-fault-task",runId:"event-fault-run",kind:"bb",contract:{}});
    db.exec("CREATE TEMP TRIGGER fail_stage_event BEFORE INSERT ON lane_pilot_stage_event BEGIN SELECT RAISE(ABORT, 'injected event failure'); END");
    expect(()=>saveStageReceipt(db,{contractVersion:1,runId:"event-fault-run",taskId:"event-fault-task",stageId:"plan-critique",state:"passed",
      inputSha256:"a".repeat(64),outputSha256:"b".repeat(64),attempt:1,providerId:null,model:null,threadId:null,result:null,reason:null,updatedAt:1,
    })).toThrow("injected event failure");
    expect(listStageReceipts(db,"event-fault-run","event-fault-task")).toEqual([]);
    expect(listStageEvents(db,{projectId:"A",since:0})).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("stores categorized gate evaluations as project-scoped append-only evidence",async()=>{
    const {bb,harness}=createFakePluginHost({pluginId:"lane-pilot"}),db=openDatabase(bb);
    createRun(db,"gate-event-run","A");createTask(db,{id:"gate-event-task",runId:"gate-event-run",kind:"bb",contract:{}});
    appendGateEvaluation(db,{projectId:"A",runId:"gate-event-run",taskId:"gate-event-task",gate:"owns-paths",status:"rejected",
      inputSha256:"a".repeat(64),outputSha256:"b".repeat(64),attempt:1,occurredAt:10});
    expect(listGateEvents(db,{projectId:"A",since:0,gate:"owns-paths"})).toMatchObject([{gate:"owns-paths",status:"rejected",inputSha256:"a".repeat(64)}]);
    expect(listGateEvents(db,{projectId:"B",since:0})).toEqual([]);
    expect(()=>db.prepare("UPDATE lane_pilot_gate_event SET status='passed' WHERE id=1").run()).toThrow("append-only");
    expect(()=>db.prepare("DELETE FROM lane_pilot_gate_event WHERE id=1").run()).toThrow("append-only");
    expect(()=>appendGateEvaluation(db,{projectId:"A",runId:"gate-event-run",taskId:"gate-event-task",gate:"unknown" as never,status:"passed",
      inputSha256:"a".repeat(64),outputSha256:null,attempt:1,occurredAt:11})).toThrow(/CHECK/);
    await harness.lifecycle.dispose();
  });

  it("claims one scheduled docs run per project and local date with project isolation", async () => {
    const {bb,harness} = createFakePluginHost({pluginId:"lane-pilot"});
    const db = openDatabase(bb);
    expect(claimDailySchedule(db,"project-a","docs-maintenance","2026-09-23")).toBe(true);
    expect(claimDailySchedule(db,"project-a","docs-maintenance","2026-09-23")).toBe(false);
    expect(claimDailySchedule(db,"project-a","docs-maintenance","2026-09-24")).toBe(true);
    expect(claimDailySchedule(db,"project-b","docs-maintenance","2026-09-23")).toBe(true);
    expect(() => claimDailySchedule(db,"project-a","../docs","2026-09-25")).toThrow("schedule name");
    expect(() => claimDailySchedule(db,"project-a","docs-maintenance","2026-02-31")).toThrow("schedule date");
    await harness.lifecycle.dispose();
  });

  it("claims docs spawn once while running and thread_id is null", async () => {
    const {bb,harness} = createFakePluginHost({pluginId:"lane-pilot"});
    const db = openDatabase(bb);
    createRun(db, "docs-claim-run", "project-a");
    createTask(db, { id:"docs-claim-task", runId:"docs-claim-run", kind:"bb", contract:{id:"docs-claim-task"} });
    saveStageReceipt(db, {
      runId:"docs-claim-run", taskId:"docs-claim-task", stageId:"docs-maintenance", contractVersion:1, state:"running",
      inputSha256:"a".repeat(64), outputSha256:null, attempt:0, providerId:null, model:null,
      threadId:null, result:{ snapshot:{ pages:[], since:"yesterday", truncated:false, inputSha256:"b".repeat(64) } },
      reason:"docs_spawn_requested", updatedAt:Date.now(),
    });
    expect(claimDocsSpawn(db,"docs-claim-run","docs-claim-task")).toBe(true);
    expect(claimDocsSpawn(db,"docs-claim-run","docs-claim-task")).toBe(false);
    expect((listStageReceipts(db,"docs-claim-run","docs-claim-task")[0].result as {spawnAttempted?:boolean}).spawnAttempted).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("claims onboarding spawn once while running and thread_id is null", async () => {
    const {bb,harness} = createFakePluginHost({pluginId:"lane-pilot"});
    const db = openDatabase(bb);
    createRun(db, "onboard-claim-run", "project-a");
    createTask(db, { id:"onboard-claim-task", runId:"onboard-claim-run", kind:"bb", contract:{id:"onboard-claim-task"} });
    saveStageReceipt(db, {
      runId:"onboard-claim-run", taskId:"onboard-claim-task", stageId:"onboarding-preview", contractVersion:1, state:"running",
      inputSha256:"a".repeat(64), outputSha256:null, attempt:0, providerId:null, model:null,
      threadId:null, result:{ snapshot:{ pages:[], inputBytes:0, inputPageCount:0, availablePageCount:0, acceptanceSha256:"b".repeat(64), agent:"project-onboarder", depth:"fast" } },
      reason:"onboarding_spawn_requested", updatedAt:Date.now(),
    });
    expect(claimStageSpawn(db,"onboard-claim-run","onboard-claim-task","onboarding-preview")).toBe(true);
    expect(claimStageSpawn(db,"onboard-claim-run","onboard-claim-task","onboarding-preview")).toBe(false);
    expect((listStageReceipts(db,"onboard-claim-run","onboard-claim-task")[0].result as {spawnAttempted?:boolean}).spawnAttempted).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("binds a managed workspace exactly once before run dispatch", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "worktree-run", "A", "bb", null);
    expect(setRunWorkspace(db, "worktree-run", "/tmp/lane-managed-worktree", "env-managed")).toBe(true);
    expect(setRunWorkspace(db, "worktree-run", "/tmp/other", "env-other")).toBe(false);
    expect(getRun(db, "worktree-run")).toMatchObject({
      writer_workspace_path:"/tmp/lane-managed-worktree", writer_environment_id:"env-managed", state:"pending",
    });
    setRunThread(db, "worktree-run", "pm-worktree");
    expect(setRunWorkspace(db, "worktree-run", "/tmp/late", "env-late")).toBe(false);
    await harness.lifecycle.dispose();
  });

  it("freezes native host+path+environment once and refuses a second bind", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "native-run", "A", "bb", null);
    expect(freezeRunBinding(db, "native-run", { hostId: "host-mini", workspacePath: "/tmp/fixture", environmentId: "env-live" })).toBe(true);
    expect(getRunWriterHost(db, "native-run")).toBe("host-mini");
    expect(getRun(db, "native-run")).toMatchObject({
      writer_workspace_path: "/tmp/fixture",
      writer_environment_id: "env-live",
    });
    expect(freezeRunBinding(db, "native-run", { hostId: "host-other", workspacePath: "/tmp/other", environmentId: "env-other" })).toBe(false);
    expect(getRunWriterHost(db, "native-run")).toBe("host-mini");
    await harness.lifecycle.dispose();
  });

  it("freezes writer_host_id at createRun and does not expose it through getRun", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "host-frozen", "A", "bb", "/repo", "none", {schemaVersion:1,pools:{provider:5,verification:2}}, "host-a");
    expect(getRunWriterHost(db, "host-frozen")).toBe("host-a");
    expect(getRun(db, "host-frozen")).not.toHaveProperty("writer_host_id");
    await harness.lifecycle.dispose();
  });

  it("stores the run gate as an immutable run-scoped snapshot", async () => {
    const {bb,harness}=createFakePluginHost({pluginId:"lane-pilot"});
    const db=openDatabase(bb);
    createRun(db,"run-gated","A","bb","/repo","pre-merge");
    createRun(db,"run-default","A","bb","/repo");
    expect(getRun(db,"run-gated")).toMatchObject({run_gate:"pre-merge"});
    expect(getRun(db,"run-default")).toMatchObject({run_gate:"none"});
    expect(()=>db.prepare("UPDATE lane_pilot_run SET run_gate='invalid' WHERE id='run-gated'").run()).toThrow(/CHECK/);
    await harness.lifecycle.dispose();
  });

  it("persists the validated run-v2 pool profile as a run snapshot",async()=>{
    const {bb,harness}=createFakePluginHost({pluginId:"lane-pilot"});
    const db=openDatabase(bb);
    createRun(db,"run-pools","A","bb","/repo","none",{schemaVersion:1,pools:{provider:6,verification:4}});
    expect(JSON.parse(getRun(db,"run-pools")!.run_policy_json)).toEqual({schemaVersion:1,pools:{provider:6,verification:4}});
    await harness.lifecycle.dispose();
  });

  it("binds an immutable workspace and routing decision to a queued attempt with CAS", async () => {
    const {bb,harness}=createFakePluginHost({pluginId:"lane-pilot"});
    const db=openDatabase(bb);
    createRun(db,"attempt-workspace-run","A","bb","/repo");
    createTask(db,{id:"attempt-workspace-task",runId:"attempt-workspace-run",kind:"bb",contract:{}});
    createAttempt(db,{id:"attempt-workspace-1",runId:"attempt-workspace-run",taskId:"attempt-workspace-task"});
    expect(setAttemptHolderThread(db,"attempt-workspace-1","holder-thread-1")).toBe(true);
    expect(setAttemptHolderThread(db,"attempt-workspace-1","holder-thread-2")).toBe(false);
    expect(getAttempt(db,"attempt-workspace-1")).toMatchObject({holder_thread_id:"holder-thread-1",thread_id:null});
    const decision={mode:"auto",risk:"high",score:8,multiWrite:true,isolated:true,reason:"risk_threshold"};
    expect(setAttemptWorkspace(db,"attempt-workspace-1",{path:"/worktrees/task-1",environmentId:"env-task-1",decision})).toBe(true);
    expect(getAttempt(db,"attempt-workspace-1")).toMatchObject({workspace_path:"/worktrees/task-1",environment_id:"env-task-1",workspace_decision:decision});
    expect(setAttemptWorkspace(db,"attempt-workspace-1",{path:"/worktrees/stale",environmentId:"env-stale",decision})).toBe(false);
    expect(()=>setAttemptWorkspace(db,"attempt-workspace-1",{path:"relative/path",environmentId:null,decision})).toThrow("must be absolute");
    transitionAttempt(db,"attempt-workspace-1","running");
    expect(setAttemptWorkspace(db,"attempt-workspace-1",{path:"/worktrees/late",environmentId:null,decision})).toBe(false);
    await harness.lifecycle.dispose();
  });
});
