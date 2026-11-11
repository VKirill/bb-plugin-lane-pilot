import { resolve } from "node:path";
import { bestEffort } from "@lane-pilot/kit";
import { sha256 } from "../../tasks";
import { docsWorktreeKey } from "../../contracts";
import { docsMergeNote } from "./docs-merge-note";
import { pluginStopped } from "./plugin-stopped";
import { DOCS_UNITS_OPEN_KEY } from "./docs-unit-records";
import type { NightlyShared, DocsUnitRecord } from "./docs-night-state";

  /**
   * The docs worktree of a place: Lane Pilot's own git worktree on lane/docs-<hash>, fresh from main for each pass.
   * The docs agents used to write in the project checkout for hours, so a deploy found it dirty and its git busy, and an
   * agent interrupted mid-command left .git/index.lock behind (SelfyStudio, 2026-10-03). A pass that broke off keeps
   * its worktree while units still have saved progress in it. Without a worktree the pass runs in place, as before.
   */
  export async function docsWorktree(n:NightlyShared,place:{
hostId:string;path:string}):Promise<{hostId:string;path:string}> {
    const {bb,host}=n;
    const name=`docs-${sha256(place.path).slice(0,12)}`, key=docsWorktreeKey(place.hostId, name);
    const known=await bb.storage.kv.get(key) as {path?:string}|null;
    let missing=false;
    if(known?.path){
      // A durable marker can outlive its folder. Recreate a missing copy through gitCreateWorktree, which keeps
      // an unmerged lane branch; a failed inspection must keep the marker and the work for a later retry.
      const state=await host.call("gitWorktreeState",{requestedHostId:place.hostId,basePath:place.path,worktreePath:known.path},{hostId:place.hostId,timeoutMs:120_000});
      if(state.status==="failed") throw new Error(`docs_worktree_inspection_failed: ${state.reason}`);
      missing=state.status==="missing";
      if(state.status==="ready"){
        const open=(await bb.storage.kv.get(DOCS_UNITS_OPEN_KEY) as Record<string,true>|null)??{};
        for(const unitKey of Object.keys(open)){
          const record=await bb.storage.kv.get(unitKey) as DocsUnitRecord|null;
          if(record?.place.path===known.path) return {hostId:place.hostId,path:known.path};
        }
        // Its committed pages reach main before it goes; a busy main waits for the next tick.
        const merged=await mergeDocs(n,place.path,{hostId:place.hostId,path:known.path},"docs: earlier pass",true);
        if(merged==="busy") throw new Error("docs_worktree_merge_busy: main is merging other work; the pass retries");
        await bestEffort(bb.log, `docs worktree cleanup ${known.path}`, host.call("gitRemoveWorktree",{requestedHostId:place.hostId,basePath:place.path,worktreePath:known.path},{hostId:place.hostId,timeoutMs:120_000}), null);
        await bestEffort(bb.log, `docs worktree record ${key}`, bb.storage.kv.delete(key), undefined);
      }
    }
    const created=await host.call("gitCreateWorktree",{requestedHostId:place.hostId,basePath:place.path,name},{hostId:place.hostId,timeoutMs:120_000,worktreeOwner:{kind:"docs",id:name}}).catch((cause)=>({status:"failed" as const,path:null,reason:cause instanceof Error?cause.message:String(cause)}));
    if(created.status!=="ready"||!created.path){
      if(missing) throw new Error(`docs_worktree_recovery_failed: ${created.reason}`);
      bb.log.warn(`Lane Pilot docs worktree for ${place.path} not created (${created.reason}); the pass works in the checkout`);
      return place;
    }
    await bb.storage.kv.set(key,{path:created.path});
    return {hostId:place.hostId,path:created.path};
  }

  /** Merges the docs worktree's commits into the project checkout under the writers' merge lock; null when there is no worktree. */
  export async function mergeDocs(n:NightlyShared,basePath:string,work:{
hostId:string;path:string},message:string,leftover=false):Promise<string|null> {
    const {bb,host}=n;
    if(resolve(work.path)===resolve(basePath)) return null;
    const result=await host.call("gitIntegrate",{requestedHostId:work.hostId,basePath,worktreePath:work.path,message,committedOnly:true},{hostId:work.hostId,timeoutMs:300_000})
      .catch((cause)=>({status:"failed" as const,reason:cause instanceof Error?cause.message:String(cause),conflicts:[] as string[]}));
    const note=docsMergeNote(basePath,result,leftover);
    if(note&&!pluginStopped(result.reason??"")) bb.log[note.level](note.message);
    return result.status;
  }
