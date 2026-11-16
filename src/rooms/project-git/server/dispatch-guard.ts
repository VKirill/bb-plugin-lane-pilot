import { isAbsolute, relative, resolve } from "node:path";
import { stringAt, valueAt } from "@lane-pilot/kit";
import { beginRunAdmission, getAttempt, getRun, getRunWriterHost, latestRunForPmThread, listOpenAttempts, taskBasePath, type LanePilotDatabase } from "../../storage";
import { isLiveDecision } from "../../writer/live-folder";
import type { ProjectGit, ScopeResult } from "./bootstrap";

export type ProjectGitDispatchArgs = {
  threadId:string; projectId:string; task?: { id:string; project_cwd?: string; repo_scope?: boolean; [key:string]:unknown };
  [key:string]:unknown;
};
export type ProjectGitDispatch = (args:ProjectGitDispatchArgs)=>Promise<Record<string,unknown>>;
export type FolderPool = {
  acquire(key:string,limit:number,rank?:number):Promise<()=>void>;
  acquireFolder?(hostId:string,path:string,rank?:number):Promise<()=>void>;
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
  const blocked=db.prepare(`SELECT a.id,a.run_id,a.task_id,a.workspace_path,a.workspace_decision_json
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.state='blocked' AND r.closed_at IS NULL
      AND a.created_at=(SELECT MAX(b.created_at) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)`).all() as Array<{id:string;run_id:string;task_id:string;workspace_path:string|null;workspace_decision_json:string|null}>;
  for (const row of blocked) {
    const run=getRun(db,row.run_id);
    if (!run || getRunWriterHost(db,row.run_id)!==hostId) continue;
    let decision:unknown=null;
    if (row.workspace_decision_json) { try { decision=JSON.parse(row.workspace_decision_json); } catch { decision={ invalidStoredDecision:true }; } }
    consider(row.run_id,row.workspace_path,decision);
  }
  return [...new Set(found)];
}

type GuardDeps = {
  db:LanePilotDatabase;
  bb:{ sdk:{ threads:{ getPluginMetadata(input:{threadId:string}):Promise<unknown> } }; storage:{ kv:{ delete(key:string):Promise<unknown> } } };
  projectGit:ProjectGit;
  runWriterPool:FolderPool;
  raw:ProjectGitDispatch;
  isDisposed?:()=>boolean;
};

const refusal=(runId:string,result:unknown,detail:string):Record<string,unknown>=>({
  ok:false, runId, state:"rejected",
  error:{ code:"project_git_required", retryable:true, sideEffects:typeof result==="object"&&result!==null&&"kind" in result&&((result as {kind?:unknown}).kind==="bootstrapped")?"unknown":"none", hint:detail },
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
      if (!args.task || typeof args.task.project_cwd!=="string" || !within(args.task.project_cwd,run.writer_workspace_path)) return deps.raw(args);
      const scope=await deps.projectGit.resolveScope({
        threadId:args.threadId, hostId, projectRoot:run.writer_workspace_path, sectionPath:args.task.project_cwd,
        taskKey:args.task.id,
      });
      if (scope.kind==="repo") return deps.raw(args);
      if (scope.kind==="stopped") return refusal(runId,scope,`private Git bootstrap is stopped (${scope.stage}:${scope.code}): ${scope.detail}`);
      if (deps.isDisposed?.()) return refusal(runId,scope,"Lane Pilot stopped while the owner form was open; no Git bootstrap or task dispatch was started");
      const root=scopeRoot(scope);
      if (!root) return refusal(runId,scope,`private Git is required before dispatch: ${scope.kind}`);
      const releaseFolder=await (deps.runWriterPool.acquireFolder
        ? deps.runWriterPool.acquireFolder(hostId,root)
        : deps.runWriterPool.acquire(`live-folder:${hostId}:${resolve(root)}`,1));
      try {
        if (deps.isDisposed?.()) return refusal(runId,scope,"Lane Pilot stopped before the Git mutation boundary; retry from the current PM run");
        const result=await deps.projectGit.bootstrap({ hostId, root, account:scope.kind==="chosen"||scope.kind==="resume"?scope.account:"" });
        if (!result.ok) return refusal(runId,{ kind:"bootstrapped", result },`private Git did not complete (${result.stage}:${result.code}): ${result.detail}; no task or attempt was admitted, but Git side effects may exist`);
        // isLiveFolder caches by run id; the next writer probe must observe the new repository.
        await deps.bb.storage.kv.delete(`live-folder:${runId}`);
        if (deps.isDisposed?.()) return refusal(runId,{ kind:"bootstrapped", result },"Lane Pilot stopped after Git bootstrap; no task or attempt was admitted and Git side effects may exist");
        return deps.raw(args);
      } finally { releaseFolder(); }
    } finally { releaseAdmission(); }
  };
}
