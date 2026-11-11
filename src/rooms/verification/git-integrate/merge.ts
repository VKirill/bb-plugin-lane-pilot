import { existsSync } from "node:fs";
import { join } from "node:path";
import { bestEffort } from "@lane-pilot/kit";
import { ENVIRONMENT_REASON, REPLAY_CHECK_FAILED } from "../../contracts/failure-class";
import { recordedReplayFailure } from "../replay-cache";
import { BASE_MOVED, HEAD_MOVED, BaseLockBusyError, changedBetween, git, identity } from "./git-core";
import type { GitIntegration, ReplayCheckOutcome } from "./git-core";
import { INDEX_LOCKED, abortStaleMerge, indexLockGone, recoverStaleGitLock, withBaseLock } from "./locks";
import { removeEmptyWorktreeParent, worktreeTop } from "./worktree-hygiene";
import { resolveBookkeepingToMain, settleStagedBookkeeping, stageOwnedBookkeeping, stagedPaths } from "./bookkeeping";
import { rebuildChangedPackages } from "./deps-install";
import { liftOwnsBarrier } from "./owns-barrier";

/**
 * Replays the attempt's commits on the base checkout's current HEAD, in the attempt's own worktree. Returns the new tip,
 * or null when there was nothing to replay or a commit conflicts: the rebase is then undone, the branch is as it was.
 */
async function rebaseOntoBase(worktreePath:string, baseHead:string):Promise<string|null> {
  if((await git(worktreePath,["merge-base","--is-ancestor",baseHead,"HEAD"])).ok) return null;
  if(!(await git(worktreePath,[...await identity(worktreePath),"rebase",baseHead])).ok) {
    await git(worktreePath,["rebase","--abort"]);
    return null;
  }
  const tip=await git(worktreePath,["rev-parse","HEAD"]);
  return tip.ok&&tip.stdout.trim()?tip.stdout.trim():null;
}

/**
 * Commits the writer's worktree and merges it into the run's base checkout (main).
 * A conflict leaves main untouched and names the files, so the task can be redone on the new main.
 */
export async function integrateWorktree(input:{basePath:string;worktreePath:string;message:string;removeWorktree?:boolean;lockWaitMs?:number;
  /** Merge only what is committed: the docs worktree holds other units' unchecked pages beside the commit. */
  committedOnly?:boolean;
  /** The project's own bookkeeping patterns (bookkeeping.paths), settled to main's version in the merge. */
  bookkeeping?:string[];
  /** The task's owns_paths: a bookkeeping file the task owns is its work, so the merge keeps the attempt's version of it. */
  ownsPaths?:string[];
  /** Merge only when main, read under the base lock, is already an ancestor of the worktree's head (a phase candidate that took main in
   *  and was verified): main that moved in between is not merged into the verified package; it says `moved` (BASE_MOVED). */
  baseInHead?:boolean;
  /** The worktree head the merge must find under the base lock, and the commit it merges: a candidate that moved after it was verified says `moved` (HEAD_MOVED). */
  expectedHead?:string;
  /** Run once the attempt was replayed on a moved main, before the merge (a semantic clash shows only there). */
  replayCheck?:()=>Promise<ReplayCheckOutcome>;
  /** How long a merge stopped by another git's fresh index.lock in the base waits for that lock to go before it gives up. */
  indexLockWaitMs?:number;
  /** How long machine-written files staged in the base's index (a stage between `git add` and `git commit`) get to be committed by their stager; then they are committed here. */
  stagedWaitMs?:number}):Promise<GitIntegration> {
  const fail=(reason:string):GitIntegration=>({status:"failed",commit:null,conflicts:[],reason});
  // The owns-paths barrier comes down before the merge: the integration writes where the writer could not (F-01).
  await bestEffort(console.warn, `owns barrier lift ${input.worktreePath}`, liftOwnsBarrier(input.worktreePath), {restored:0});
  await recoverStaleGitLock(input.worktreePath);
  if(!input.committedOnly&&input.ownsPaths?.length) await stageOwnedBookkeeping(input.worktreePath,input.ownsPaths,input.bookkeeping??[]);
  const dirty=input.committedOnly?{ok:true as const,stdout:"",reason:""}:await git(input.worktreePath,["status","--porcelain","--untracked-files=all"]);
  if(!dirty.ok) return fail(`worktree status: ${dirty.reason}`);
  if(dirty.stdout.trim()) {
    const add=await git(input.worktreePath,["add","-A"]);
    if(!add.ok) return fail(`worktree add: ${add.reason}`);
    // The project's own git hooks run here as they do for any commit and for the merge below: a hook
    // that rejects the writer's work fails the attempt with its output, and the retry has to satisfy it.
    const commit=await git(input.worktreePath,[...await identity(input.worktreePath),"commit","-q","-m",input.message]);
    if(!commit.ok) return fail(`project git hook or commit rejected the writer's work: ${commit.reason.split("\n").slice(-12).join("\n")}`);
  }
  const head=await git(input.worktreePath,["rev-parse","HEAD"]);
  if(!head.ok) return fail(`worktree head: ${head.reason}`);
  const sha=head.stdout.trim();
  const branch=(await git(input.worktreePath,["rev-parse","--abbrev-ref","HEAD"])).stdout.trim();
  let result:GitIntegration;
  try {
    result=await withBaseLock(input.basePath,async()=>{
      await recoverStaleGitLock(input.basePath);
      await abortStaleMerge(input.basePath);
      await settleStagedBookkeeping(input.basePath,input.bookkeeping??[],input.stagedWaitMs);
      const before=(await git(input.basePath,["rev-parse","HEAD"])).stdout.trim();
      if(input.expectedHead) {
        const now=(await git(input.worktreePath,["rev-parse","HEAD"])).stdout.trim();
        if(now!==input.expectedHead) return fail(`${HEAD_MOVED}: it is at ${now.slice(0,12)}, the verdict saw ${input.expectedHead.slice(0,12)}`);
      }
      const target=input.expectedHead??sha;
      if(input.baseInHead&&before&&!(await git(input.worktreePath,["merge-base","--is-ancestor",before,target])).ok) return fail(`${BASE_MOVED}: main is at ${before.slice(0,12)}, not in ${target.slice(0,12)}`);
      // Main moved while the writer worked: replay the attempt on the current main first. Clean, it merges without
      // another writer turn; a real conflict is left as it was and the merge below reports it for the free redo.
      // The attempt's own branch only: Lane Pilot's lane/<attempt> and the BB-managed bb/<attempt> worktree (one per attempt too).
      const rebased=(branch.startsWith("lane/")||branch.startsWith("bb/"))&&before?await rebaseOntoBase(input.worktreePath,before):null;
      // A worktree that was already replayed onto this base needs no second run: its recorded verdicts stand (G8). A
      // recorded red still refuses the merge — otherwise a retried integration would merge code whose checks failed.
      if(!rebased&&input.replayCheck) {
        const settled=await recordedReplayFailure(input.worktreePath);
        if(settled) return {status:"conflict",commit:null,conflicts:[],reason:`${REPLAY_CHECK_FAILED}: verification failed (${settled.command})`,checks:[{command:settled.command,exitCode:settled.exitCode||1,stdout:settled.stdout,stderr:settled.stderr}],failureCode:settled.exitCode===124?"verification_timeout":"verification_failed",checkName:settled.command};
      }
      // main moved and the attempt was replayed on it: the replayed result has not been run anywhere yet, and two tasks
      // that merge cleanly can still break each other. Red, nothing merges: the writer gets the output as a free redo.
      if(rebased&&input.replayCheck) {
        // The replay brought main's package sources into the worktree, but their dist/ is still the copy taken when the
        // attempt started: a new export another task merged was «missing» and the check went red (SelfyStudio, 2026-10-14
        // public-from-scratch-prices and 2026-10-19 v2-blog-archive, TS2305 from @selfystudio/contracts).
        for(const build of await rebuildChangedPackages(input.worktreePath,sha,rebased)) {
          if(!build.ok) console.warn(`lane-pilot: rebuilding ${build.dir} in ${input.worktreePath} after the replay failed: ${build.detail??""}`);
        }
        const replay=await input.replayCheck();
        if(!replay.ok) {
          const failed=replay.failed;
          return {status:"conflict",commit:null,conflicts:[],reason:`${REPLAY_CHECK_FAILED}: verification failed (${failed.map((check)=>check.command).join(", ")})${replay.environment?`: ${ENVIRONMENT_REASON}the check did not run`:""}`,checks:failed,failureCode:failed.some((check)=>check.exitCode===124)?"verification_timeout":"verification_failed",checkName:failed[0]?.command};
        }
      }
      const merged=await merge(input.basePath,rebased??input.expectedHead??sha,input.message,input.bookkeeping,input.ownsPaths,input.indexLockWaitMs);
      if(rebased&&merged.status==="merged") merged.rebased=true;
      // What main was and what the merge changed in it, so the record can say «roll back to what» without the checkout.
      if(merged.status==="merged"&&before&&merged.commit) { merged.base=before; merged.changed=await changedBetween(input.basePath,before,merged.commit); }
      if(merged.status==="merged"&&before) merged.rebuilt=await rebuildChangedPackages(input.basePath,before,"HEAD");
      return merged;
    },input.message,input.lockWaitMs);
  }
  catch(error) {
    if(!(error instanceof BaseLockBusyError)) throw error;
    // The writer's work stays committed in its worktree; the next try merges it.
    return {status:"busy",commit:sha,conflicts:[],reason:error.message,holder:error.holder};
  }
  // Lane Pilot's own worktree is done once its work is in main. A conflict keeps it: uncommitted edits in main block
  // the merge without anything to redo, and the committed work there is merged as soon as main is clean.
  if(input.removeWorktree&&(result.status==="merged"||result.status==="up-to-date")) {
    const top=await worktreeTop(input.worktreePath);
    if((await git(input.basePath,["worktree","remove","--force",top])).ok) await removeEmptyWorktreeParent(top);
    if(branch.startsWith("lane/")) await git(input.basePath,["branch","-D",branch]);
  }
  return result;
}

/**
 * Brings a writer's worktree up to the base checkout's HEAD, so the same writer can take the area's next task there:
 * a fast-forward when main only moved ahead (its own work was merged), else a merge. A conflict is undone and named:
 * the caller then starts a fresh writer instead.
 */
export async function syncWorktree(input:{basePath:string;worktreePath:string;
  /** Leave a conflicted merge in place for the writer to resolve, instead of undoing it. */
  keepConflicts?:boolean}):Promise<{status:"synced"|"up-to-date"|"dirty"|"conflict"|"failed";head:string|null;reason:string|null;conflicts?:string[]}> {
  const fail=(status:"dirty"|"conflict"|"failed",reason:string)=>({status,head:null,reason});
  await recoverStaleGitLock(input.worktreePath);
  const dirty=await git(input.worktreePath,["status","--porcelain","--untracked-files=no"]);
  if(!dirty.ok) return fail("failed",`worktree status: ${dirty.reason}`);
  if(dirty.stdout.trim()) return fail("dirty",`uncommitted changes: ${dirty.stdout.trim().split("\n").slice(0,5).join("; ")}`);
  const main=await git(input.basePath,["rev-parse","HEAD"]);
  if(!main.ok) return fail("failed",`base head: ${main.reason}`);
  const sha=main.stdout.trim();
  const head=async()=>(await git(input.worktreePath,["rev-parse","HEAD"])).stdout.trim()||null;
  if((await git(input.worktreePath,["merge-base","--is-ancestor",sha,"HEAD"])).ok) return {status:"up-to-date",head:await head(),reason:null};
  if((await git(input.worktreePath,["merge","--ff-only","-q",sha])).ok) return {status:"synced",head:await head(),reason:null};
  const merged=await git(input.worktreePath,[...await identity(input.worktreePath),"merge","--no-edit","-q",sha]);
  if(merged.ok) return {status:"synced",head:await head(),reason:null};
  const unmerged=await git(input.worktreePath,["diff","--name-only","--diff-filter=U"]);
  const conflicts=unmerged.ok?unmerged.stdout.split("\n").map((line)=>line.trim()).filter(Boolean):[];
  // The writer that made the work resolves the conflict in its worktree (Copilot, Devin and Vibe Kanban do the same).
  if(input.keepConflicts&&conflicts.length) return {status:"conflict",head:await head(),reason:`conflicts: ${conflicts.slice(0,10).join(", ")}`,conflicts};
  await git(input.worktreePath,["merge","--abort"]);
  return fail(conflicts.length?"conflict":"failed",conflicts.length?`conflicts: ${conflicts.slice(0,10).join(", ")}`:`git merge failed: ${merged.reason.split("\n").slice(-4).join("\n")}`);
}
async function merge(basePath:string,sha:string,message:string,bookkeeping:readonly string[]=[],ownsPaths:readonly string[]=[],lockWaitMs=20_000):Promise<GitIntegration> {
  const targetSha = await resolveBookkeepingToMain(basePath, sha, bookkeeping, ownsPaths);
  if((await git(basePath,["merge-base","--is-ancestor",targetSha,"HEAD"])).ok) {
    return {status:"up-to-date",commit:(await git(basePath,["rev-parse","HEAD"])).stdout.trim()||null,conflicts:[],reason:null};
  }
  const runMerge=async()=>git(basePath,[...await identity(basePath),"merge","--no-ff","--no-edit","-m",`Merge writer work: ${message}`,targetSha]);
  let merged=await runMerge();
  // The base is shared: BB, the PM and other tools run git there, and a `git status` holds index.lock for a moment. git
  // 2.37+ merges start with `git stash create`, which does not wait for that lock (OVH 2026-10-13: «fatal: stash failed»,
  // nothing changed); on a clean tree the merge stops on «Unable to write index» with MERGE_HEAD left. Once the lock
  // is gone, the unfinished merge is undone and the merge runs again.
  const deadline=Date.now()+lockWaitMs;
  while(!merged.ok&&INDEX_LOCKED.test(merged.reason)&&Date.now()<deadline&&await indexLockGone(basePath,deadline-Date.now())) {
    const gitDir=(await git(basePath,["rev-parse","--absolute-git-dir"])).stdout.trim();
    if(gitDir&&existsSync(join(gitDir,"MERGE_HEAD"))) await git(basePath,["merge","--abort"]);
    merged=await runMerge();
  }
  if(merged.ok) return {status:"merged",commit:(await git(basePath,["rev-parse","HEAD"])).stdout.trim()||null,conflicts:[],reason:null};
  const unmerged=await git(basePath,["diff","--name-only","--diff-filter=U"]);
  const conflicts=unmerged.ok?unmerged.stdout.split("\n").map((line)=>line.trim()).filter(Boolean):[];
  await git(basePath,["merge","--abort"]);
  // Git refuses to merge over uncommitted edits of the same files in main (another agent or the PM
  // works there); name those files so the retry is understood, instead of a bare "merge failed".
  if(!conflicts.length&&/(?:local changes|untracked working tree files|будут перезаписаны).*would be overwritten by merge|would be overwritten by merge/i.test(merged.reason)) {
    const overwritten=merged.reason.split("\n").filter((line)=>/^\t/.test(line)).map((line)=>line.trim()).filter(Boolean);
    if(overwritten.length) return {status:"conflict",commit:null,conflicts:overwritten,reason:"base checkout has uncommitted changes in files this attempt also changes"};
    // ort's own check of the index lists the files on one indented line, no tab, so nothing is parsed above: ask the index.
    const staged=await stagedPaths(basePath);
    if(staged?.length) return {status:"conflict",commit:null,conflicts:staged.slice(0,50),reason:"base checkout has uncommitted changes staged in its index and not committed"};
  }
  // A merge that failed without conflicted files is not a conflict: a stale index.lock, a hook, a refused checkout. Called a
  // conflict, it read as «main changed» and spent every SelfyStudio task's attempts on 2026-10-04 while main never moved.
  if(!conflicts.length) return {status:"failed",commit:null,conflicts:[],reason:`git merge failed: ${merged.reason.split("\n").slice(-4).join("\n")}`};
  return {status:"conflict",commit:null,conflicts,reason:merged.reason.split("\n").slice(-4).join("\n")};
}
