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
  const pool={acquire:vi.fn(async()=>()=>undefined),acquireFolder:vi.fn(async(_hostId:string,_path:string)=>()=>undefined)};
  const invalidateLiveFolder=vi.fn(async()=>undefined);
  const preparePlacement=vi.fn(async(input:{runId:string;hostId:string;runFolder:string;task:unknown;plan:string})=>({
    placement:{ task:{ ...(input.task as {id:string;project_cwd:string}), project_cwd:input.runFolder }, plan:input.plan },
    binding:{ runId:input.runId, hostId:input.hostId, runFolder:input.runFolder, taskId:(input.task as {id:string}).id, taskJson:"", plan:input.plan },
  }));
  const dispatch=createProjectGitDispatch({db,bb:bb as never,projectGit:projectGit as never,runWriterPool:pool,invalidateLiveFolder,preparePlacement,raw,isDisposed:()=>false});
  const task={id:"T1",project_cwd:workspace,objective:"task"};
  return {db,bb,raw,projectGit,pool,dispatch,task,invalidateLiveFolder,preparePlacement};
}

it("uses the frozen project source for section scope and holds run admission through raw dispatch", async()=>{
  const f=fixture();
  let finish!:()=>void;
  f.raw.mockImplementationOnce(()=>new Promise((resolve)=>{finish=()=>resolve({ok:true,state:"queued"});}));
  const pending=f.dispatch({threadId:"pm-thread",projectId:"project",task:f.task});
  await vi.waitFor(()=>expect(f.raw).toHaveBeenCalled());
  expect(hasRunAdmission(f.db,"pm-thread")).toBe(true);
  expect(f.projectGit.resolveScope).toHaveBeenCalledWith(expect.objectContaining({projectRoot:"/repo",sectionPath:"/repo/section"}));
  expect(f.raw).toHaveBeenCalledWith(expect.objectContaining({task:f.task}), expect.objectContaining({placement:expect.objectContaining({task:expect.objectContaining({project_cwd:"/repo/section"})})}));
  finish();
  await pending;
  expect(hasRunAdmission(f.db,"pm-thread")).toBe(false);
});

it("preflights the placed nested repository and passes that placement through raw dispatch", async()=>{
  const f=fixture("/repo");
  f.preparePlacement.mockResolvedValue({
    placement:{ task:{...f.task,project_cwd:"/repo/plugins/p"}, plan:"placed" },
    binding:{ runId:"run", hostId:"h1", runFolder:"/repo", taskId:"T1", taskJson:"", plan:"task" },
  } as never);
  f.projectGit.resolveScope.mockResolvedValue({kind:"repo",state:"origin",root:"/repo/plugins/p"} as never);
  await expect(f.dispatch({threadId:"pm-thread",projectId:"project",task:f.task})).resolves.toMatchObject({ok:true,state:"queued"});
  expect(f.projectGit.resolveScope).toHaveBeenCalledWith(expect.objectContaining({projectRoot:"/repo",sectionPath:"/repo/plugins/p"}));
  expect(f.raw).toHaveBeenCalledWith(expect.objectContaining({task:f.task}), expect.objectContaining({placement:expect.objectContaining({task:expect.objectContaining({project_cwd:"/repo/plugins/p"}),plan:"placed"})}));
  expect(f.projectGit.bootstrap).not.toHaveBeenCalled();
});

it("delegates root and nested-repository paths outside the frozen section to raw placeTask", async()=>{
  for (const project_cwd of ["/repo", "/repo/plugins/p"]) {
    const f=fixture("/repo/section");
    const result=await f.dispatch({threadId:"pm-thread",projectId:"project",task:{...f.task,project_cwd}});
    expect(result).toMatchObject({ok:true,state:"queued"});
    expect(f.raw).toHaveBeenCalledWith(expect.objectContaining({task:expect.objectContaining({project_cwd})}));
    expect(f.projectGit.resolveScope).not.toHaveBeenCalled();
  }
});

it("releases the bootstrap folder claim before raw dispatch reacquires it", async()=>{
  const f=fixture("/repo");
  f.projectGit.resolveScope.mockResolvedValue({kind:"chosen",choice:{scope:"project",root:"/repo"},account:"octo"} as never);
  let held=false;
  const releases=vi.fn();
  f.pool.acquireFolder.mockImplementation(async()=>{
    if (held) throw new Error("folder claim was still held by dispatch");
    held=true;
    return ()=>{held=false; releases();};
  });
  f.raw.mockImplementationOnce(async()=>{
    const release=await f.pool.acquireFolder!("h1","/repo");
    release();
    return {ok:true,state:"queued"};
  });
  await expect(f.dispatch({threadId:"pm-thread",projectId:"project",task:f.task})).resolves.toMatchObject({ok:true});
  expect(releases).toHaveBeenCalledTimes(2);
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

it("does not dispatch after live-folder cache invalidation fails", async()=>{
  const f=fixture("/repo");
  f.projectGit.resolveScope.mockResolvedValue({kind:"chosen",choice:{scope:"project",root:"/repo"},account:"octo"} as never);
  f.invalidateLiveFolder.mockRejectedValue(new Error("KV unavailable"));
  const result=await f.dispatch({threadId:"pm-thread",projectId:"project",task:f.task});
  expect(f.raw).not.toHaveBeenCalled();
  expect(result).toMatchObject({ok:false,error:{code:"project_git_required",sideEffects:"unknown"}});
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
