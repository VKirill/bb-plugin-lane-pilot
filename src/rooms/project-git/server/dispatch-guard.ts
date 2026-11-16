import { isAbsolute, relative, resolve } from "node:path";
import { stringAt, valueAt } from "@lane-pilot/kit";
import { beginRunAdmission, getAttempt, getRun, getRunWriterHost, latestRunForPmThread, listLatestBlockedAttemptRefs, listOpenAttempts, taskBasePath, type LanePilotDatabase } from "../../storage";
import { isLiveDecision } from "../../writer/live-folder";
import type { ProjectGit, ScopeResult } from "./bootstrap";

export type ProjectGitDispatchArgs = {
  threadId:string; projectId:string; task?: { id:string; project_cwd?: string; repo_scope?: boolean; [key:string]:unknown };
  [key:string]:unknown;
};
export type ProjectGitDispatch = (args:ProjectGitDispatchArgs)=>Promise<Record<string,unknown>>;
export type FolderPool = {
  acquire(key:string,limit:number,rank?:number):Promise<()=>void>;
  acquireFolder?(hostId:string,path:string,rank?:number,signal?:AbortSignal):Promise<()=>void>;
};

const within=(child:string,parent:string):boolean=> {
  const rel=relative(resolve(parent),resolve(child));
  return rel==="" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const overlap=(left:string,right:string):boolean=>within(left,right)||within(right,left);

/**
 * Reads the same listOpenAttempts predicate used by writer admission: open states plus retry-eligible attempts with a
 * reconcile cursor. A queued or malformed decision is intentionally treated as a blocker; this callback is called only
 * after projectGit has probed a no-Git folder, so failing closed cannot convert a writer that has not finished binding.
 */
export function overlappingLiveRuns(db:LanePilotDatabase,hostId:string,root:string):string[] {
  const found:string[]=[];
  const consider=(runId:string,path:string|null,decision:unknown):void=> {
    if (!path || !overlap(path,root)) return;
    // A live decision is authoritative. A null/invalid legacy decision is unresolved and therefore blocks conversion.
    if (isLiveDecision(decision) || decision===null || decision===undefined || (typeof decision==="object" && decision!==null && "invalidStoredDecision" in decision)) found.push(runId);
  };
  for (const row of listOpenAttempts(db)) {
    const run=getRun(db,row.run_id);
    if (!run || run.closed_at!==null || getRunWriterHost(db,row.run_id)!==hostId || !run.writer_workspace_path) continue;
    const attempt=getAttempt(db,row.id);
    const path=attempt?.workspace_path ?? taskBasePath(db,row.run_id,row.task_id) ?? run.writer_workspace_path;
    consider(row.run_id,path,attempt?.workspace_decision);
  }
  // A blocked live-folder writer can be reopened by owner answer/update, and parked live work retains its files. It is
  // not in listOpenAttempts, so include only the latest blocked attempt of each still-open run/task; old superseded rows
  // and accepted/canceled terminal rows do not pin a folder forever.
  const blocked=listLatestBlockedAttemptRefs(db);
  for (const row of blocked) {
    const run=getRun(db,row.run_id);
    if (!run || getRunWriterHost(db,row.run_id)!==hostId) continue;
    let decision:unknown=null;
    if (row.workspace_decision_json) { try { decision=JSON.parse(row.workspace_decision_json); } catch { decision={ invalidStoredDecision:true }; } }
    consider(row.run_id,row.workspace_path ?? taskBasePath(db,row.run_id,row.task_id) ?? run.writer_workspace_path,decision);
  }
  return [...new Set(found)];
}

type GuardDeps = {
  db:LanePilotDatabase;
  bb:{ sdk:{ threads:{ getPluginMetadata(input:{threadId:string}):Promise<unknown> }; projects:{ get(input:{projectId:string}):Promise<unknown> } } };
  projectGit:ProjectGit;
  runWriterPool:FolderPool;
  invalidateLiveFolder:(runId:string)=>Promise<void>;
  raw:ProjectGitDispatch;
  isDisposed?:()=>boolean;
};

const refusal=(runId:string,result:unknown,detail:string):Record<string,unknown>=>({
  ok:false, runId, state:"rejected",
  error:{ code:"project_git_required", retryable:true, sideEffects:typeof result==="object"&&result!==null&&"kind" in result&&(["bootstrapped","stopped"].includes(String((result as {kind?:unknown}).kind)))?"unknown":"none", hint:detail },
  projectGit:result,
});

function scopeRoot(scope:ScopeResult):string|null {
  if (scope.kind==="chosen") return scope.choice.root;
  if (scope.kind==="resume" || scope.kind==="stopped") return scope.root;
  return null;
}

/** Wraps only dispatchWriter. The outer admission is synchronous before metadata/ownerAsk; native dispatch acquires it again safely. */
export function createProjectGitDispatch(deps:GuardDeps):ProjectGitDispatch {
  return async (args) => {
    const preparing=latestRunForPmThread(deps.db,args.threadId);
    if (!preparing) throw new Error("PM thread has no Lane Pilot run");
    const releaseAdmission=beginRunAdmission(deps.db,preparing.id);
    try {
      const metadata=await deps.bb.sdk.threads.getPluginMetadata({threadId:args.threadId});
      if (valueAt(metadata,"role")!=="pm") throw new Error("caller is not a Lane Pilot PM thread");
      const runId=stringAt(metadata,"lanePilotRunId");
      if (!runId) throw new Error("PM thread has no lanePilotRunId");
      if (runId!==preparing.id) throw new Error("PM run changed during admission; retry from the current binding");
      const run=getRun(deps.db,runId);
      const hostId=getRunWriterHost(deps.db,runId);
      if (!run || run.project_id!==args.projectId || run.pm_thread_id!==args.threadId) throw new Error("run does not belong to this PM thread and project");
      if (!run.writer_workspace_path || !hostId) throw new Error("run has no persisted writer host and workspace binding");
      // Let raw dispatch own the existing validation/error contract; never ask the owner for an incomplete request.
      if (!args.task || typeof args.task.project_cwd!=="string") return await deps.raw(args);
      if (!within(args.task.project_cwd,run.writer_workspace_path)) {
        // placeTask proves nearest-repository ownership for root/sibling paths. Do not replace that contract with a
        // frozen-run-folder check; this guard has not selected a Git scope and must not bootstrap one here.
        return await deps.raw(args);
      }
      let project:unknown;
      try { project=await deps.bb.sdk.projects.get({projectId:args.projectId}); }
      catch (cause) { return refusal(runId,{ kind:"project_root_unresolved" },`project sources could not be read: ${cause instanceof Error?cause.message:String(cause)}; Git bootstrap was not started`); }
      const sources=project && typeof project==="object" && Array.isArray((project as {sources?:unknown}).sources)
        ? (project as {sources:Array<{hostId?:unknown;path?:unknown}>}).sources : [];
      const projectRoot=sources
        .filter((source):source is {hostId:string;path:string} => source.hostId===hostId && typeof source.path==="string" && source.path.length>0 && within(run.writer_workspace_path!,source.path))
        .sort((left,right)=>right.path.length-left.path.length)[0]?.path;
      if (!projectRoot) return refusal(runId,{ kind:"project_root_unresolved" },`no project source on frozen host ${hostId} encloses ${run.writer_workspace_path}; Git bootstrap was not started`);
      let scope:ScopeResult;
      try {
        scope=await deps.projectGit.resolveScope({
          threadId:args.threadId, hostId, projectRoot, sectionPath:args.task.project_cwd,
          taskKey:args.task.id,
        });
      } catch (cause) { return refusal(runId,{ kind:"scope_error" },`private Git preflight failed: ${cause instanceof Error?cause.message:String(cause)}; no task or attempt was admitted`); }
      if (scope.kind==="repo") return await deps.raw(args);
      if (scope.kind==="stopped") return refusal(runId,scope,`private Git bootstrap is stopped (${scope.stage}:${scope.code}): ${scope.detail}`);
      if (deps.isDisposed?.()) return refusal(runId,scope,"Lane Pilot stopped while the owner form was open; no Git bootstrap or task dispatch was started");
      const root=scopeRoot(scope);
      if (!root) return refusal(runId,scope,`private Git is required before dispatch: ${scope.kind}`);
      if (!deps.runWriterPool.acquireFolder) return refusal(runId,scope,"overlap-aware folder admission is unavailable; Git bootstrap was not started");
      const abort=new AbortController();
      const disposalPoll=setInterval(()=>{if(deps.isDisposed?.())abort.abort();},100);
      disposalPoll.unref?.();
      let releaseFolder:()=>void;
      try { releaseFolder=await deps.runWriterPool.acquireFolder(hostId,root,1,abort.signal); }
      catch (cause) {
        clearInterval(disposalPoll);
        return refusal(runId,scope,deps.isDisposed?.()?"Lane Pilot stopped while waiting for folder admission":`folder admission failed: ${cause instanceof Error?cause.message:String(cause)}`);
      }
      clearInterval(disposalPoll);
      try {
        if (deps.isDisposed?.()) return refusal(runId,scope,"Lane Pilot stopped before the Git mutation boundary; retry from the current PM run");
        let result:Awaited<ReturnType<ProjectGit["bootstrap"]>>;
        try { result=await deps.projectGit.bootstrap({ hostId, root, account:scope.kind==="chosen"||scope.kind==="resume"?scope.account:"" }); }
        catch (cause) { return refusal(runId,{ kind:"bootstrapped", result:{ ok:false, stage:"unknown", code:"bootstrap_exception", detail:String(cause) } },`private Git bootstrap failed unexpectedly: ${cause instanceof Error?cause.message:String(cause)}; no task or attempt was admitted, but Git side effects may exist`); }
        if (!result.ok) return refusal(runId,{ kind:"bootstrapped", result },`private Git did not complete (${result.stage}:${result.code}): ${result.detail}; no task or attempt was admitted, but Git side effects may exist`);
        // The live-folder service owns its generation and pending-write drain. A raw KV delete would race an older
        // probe's delayed set and could restore a stale no-git answer after this bootstrap.
        try { await deps.invalidateLiveFolder(runId); }
        catch (cause) { return refusal(runId,{ kind:"bootstrapped", result },`private Git succeeded but live-folder cache invalidation failed: ${cause instanceof Error?cause.message:String(cause)}; no task or attempt was admitted, but Git side effects may exist`); }
        if (deps.isDisposed?.()) return refusal(runId,{ kind:"bootstrapped", result },"Lane Pilot stopped after Git bootstrap; no task or attempt was admitted and Git side effects may exist");
        // The Git mutation and cache invalidation are complete. Release the folder claim before dispatch because raw
        // start/admission may need that same claim; the per-run admission remains held through raw's settled result.
        releaseFolder();
        releaseFolder=()=>undefined;
        return await deps.raw(args);
      } finally { releaseFolder(); }
    } finally { releaseAdmission(); }
  };
}
