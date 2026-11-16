import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttempt, createRun, createTask, freezeRunBinding, getAttempt, hasRunAdmission, openDatabase, setAttemptWorkspace, setRunThread } from "../../src/rooms/plugin-db";
import { createProjectGitDispatch, overlappingLiveRuns } from "../../src/rooms/project-git/server";

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});

function fixture(workspace="/repo/section") {
  const fake=createFakePluginHost({pluginId:"lane-pilot"});
  cleanups.push(()=>fake.harness.lifecycle.dispose());
  const db=openDatabase(fake.bb);
  createRun(db,"run","project","bb");
  freezeRunBinding(db,"run",{environmentId:"env",hostId:"h1",workspacePath:workspace});
  setRunThread(db,"run","pm-thread");
  const bb={...fake.bb,sdk:{...fake.bb.sdk,threads:{...fake.bb.sdk.threads,getPluginMetadata:async()=>({role:"pm",lanePilotRunId:"run"})},projects:{...fake.bb.sdk.projects,get:async()=>({sources:[{hostId:"h1",path:"/repo"}]})}}};
  const raw=vi.fn(async()=>({ok:true,state:"queued"}));
  const projectGit={resolveScope:vi.fn(async()=>({kind:"repo",state:"origin",root:"/repo"})),bootstrap:vi.fn(async()=>({ok:true,root:"/repo",fullName:"octo/repo",url:"https://github.invalid/octo/repo",commit:"abc",branch:"main"}))};
  const pool={acquire:vi.fn(async()=>()=>undefined),acquireFolder:vi.fn(async()=>()=>undefined)};
  const dispatch=createProjectGitDispatch({db,bb:bb as never,projectGit:projectGit as never,runWriterPool:pool,raw,isDisposed:()=>false});
  const task={id:"T1",project_cwd:workspace};
  return {db,bb,raw,projectGit,pool,dispatch,task};
}

it("uses the frozen project source for section scope and holds run admission through raw dispatch", async()=>{
  const f=fixture();
  let finish!:()=>void;
  f.raw.mockImplementationOnce(()=>new Promise((resolve)=>{finish=()=>resolve({ok:true,state:"queued"});}));
  const pending=f.dispatch({threadId:"pm-thread",projectId:"project",task:f.task});
  await vi.waitFor(()=>expect(f.raw).toHaveBeenCalled());
  expect(hasRunAdmission(f.db,"pm-thread")).toBe(true);
  expect(f.projectGit.resolveScope).toHaveBeenCalledWith(expect.objectContaining({projectRoot:"/repo",sectionPath:"/repo/section"}));
  finish();
  await pending;
  expect(hasRunAdmission(f.db,"pm-thread")).toBe(false);
});

it("does not dispatch after a failed bootstrap and reports uncertain side effects", async()=>{
  const f=fixture("/repo");
  f.projectGit.resolveScope.mockResolvedValue({kind:"chosen",choice:{scope:"project",root:"/repo"},account:"octo"} as never);
  f.projectGit.bootstrap.mockResolvedValue({ok:false,stage:"probe",code:"probe_unknown",detail:"host unavailable"} as never);
  const result=await f.dispatch({threadId:"pm-thread",projectId:"project",task:f.task});
  expect(f.raw).not.toHaveBeenCalled();
  expect(result).toMatchObject({ok:false,error:{code:"project_git_required",sideEffects:"unknown"}});
  expect(hasRunAdmission(f.db,"pm-thread")).toBe(false);
});

it("contains a bootstrap exception as an uncertain no-task refusal", async()=>{
  const f=fixture("/repo");
  f.projectGit.resolveScope.mockResolvedValue({kind:"chosen",choice:{scope:"project",root:"/repo"},account:"octo"} as never);
  f.projectGit.bootstrap.mockRejectedValue(new Error("durable KV write failed"));
  const result=await f.dispatch({threadId:"pm-thread",projectId:"project",task:f.task});
  expect(f.raw).not.toHaveBeenCalled();
  expect(result).toMatchObject({ok:false,error:{code:"project_git_required",sideEffects:"unknown"}});
  expect(hasRunAdmission(f.db,"pm-thread")).toBe(false);
});

it("fails closed for active queued or unresolved live work, but ignores accepted terminal work",()=>{
  const f=fixture("/repo");
  createTask(f.db,{id:"queued-task",runId:"run",kind:"bb",contract:{project_cwd:"/repo"}});
  createAttempt(f.db,{id:"queued-attempt",runId:"run",taskId:"queued-task"});
  setAttemptWorkspace(f.db,"queued-attempt",{path:"/repo",environmentId:null,decision:null});
  expect(overlappingLiveRuns(f.db,"h1","/repo")).toContain("run");
  f.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='queued-attempt'").run();
  expect(overlappingLiveRuns(f.db,"h1","/repo")).not.toContain("run");
  expect(getAttempt(f.db,"queued-attempt")?.state).toBe("accepted");
});
