import { stat } from "node:fs/promises";
import { git, identity, changedBetween, TASK_FOLDER_EXCLUDE, type ChangedFile } from "./git-integrate";

/**
 * The git side of rolling work back (SMA wall 4: every job rolls back to the state before it, and the record names that
 * state; rule 9: a stop is a confirmed exit and the work returned). Everything here runs on the machine that holds the
 * project; the hub only asks and records.
 */

const SHA = /^[a-f0-9]{40,64}$/;
const ATTEMPT_TRAILER = (attemptId:string) => `Lane-Pilot-Attempt: ${attemptId}`;

export type WorktreeState = {
  status:"ready"|"missing"|"failed";
  /** The worktree's HEAD and the commit it forked from the base checkout's HEAD (null when they share no history). */
  head:string|null; base:string|null;
  /** Files with uncommitted changes, and commits on the worktree's branch that no other branch has. */
  dirty:number; ahead:number;
  /** Everything the worktree changed against its base: committed, uncommitted and new files, deletions included. */
  changed:ChangedFile[];
  reason:string|null;
};

/** What a worktree holds now and where it started, without touching it. Used when a stop is confirmed and before a failed attempt's worktree goes. */
export async function worktreeState(input:{basePath:string;worktreePath:string}):Promise<WorktreeState> {
  const empty = (status:WorktreeState["status"], reason:string|null):WorktreeState => ({status,head:null,base:null,dirty:0,ahead:0,changed:[],reason});
  if(!(await stat(input.worktreePath).catch(()=>null))?.isDirectory()) return empty("missing",null);
  const head=await git(input.worktreePath,["rev-parse","HEAD"]);
  if(!head.ok||!SHA.test(head.stdout.trim())) return empty("failed",head.ok?"HEAD is not a commit":head.reason);
  const baseHead=await git(input.basePath,["rev-parse","HEAD"]);
  const fork=baseHead.ok?await git(input.worktreePath,["merge-base","HEAD",baseHead.stdout.trim()]):null;
  const base=fork?.ok&&SHA.test(fork.stdout.trim())?fork.stdout.trim():null;
  const status=await git(input.worktreePath,["status","--porcelain","--untracked-files=all"]);
  if(!status.ok) return empty("failed",status.reason);
  const dirty=status.stdout.split("\n").filter(Boolean).length;
  const own=(await git(input.worktreePath,["rev-parse","--abbrev-ref","HEAD"])).stdout.trim();
  const others=(await git(input.worktreePath,["for-each-ref","--format=%(refname)","refs/heads"])).stdout.split("\n").filter((ref)=>ref&&ref!==`refs/heads/${own}`);
  const ahead=Number.parseInt((await git(input.worktreePath,["rev-list","--count","HEAD","--not",...others])).stdout.trim(),10)||0;
  const changed=new Map<string,string>();
  if(base) {
    // The tree now against the fork point: committed and uncommitted tracked changes, deletions as D.
    const diff=await git(input.worktreePath,["diff","--name-status","-z","--no-renames",base]);
    const parts=diff.ok?diff.stdout.split("\0").filter(Boolean):[];
    for(let i=0;i+1<parts.length;i+=2) changed.set(parts[i+1]!,parts[i]![0]!);
  } else {
    // No fork point: the porcelain list is all there is (a deleted file shows as D).
    for(const line of status.stdout.split("\n").filter(Boolean)) changed.set(line.slice(3).trim().replace(/^.* -> /,""),line.slice(0,2).includes("D")?"D":line.startsWith("??")?"A":"M");
  }
  const untracked=await git(input.worktreePath,["ls-files","-o","--exclude-standard","-z"]);
  for(const path of untracked.ok?untracked.stdout.split("\0").filter(Boolean):[]) if(!changed.has(path)) changed.set(path,"A");
  const taskFolder=TASK_FOLDER_EXCLUDE.replace(/^\*\*\//,"");
  return {status:"ready",head:head.stdout.trim(),base,dirty,ahead,reason:null,
    changed:[...changed].filter(([path])=>!path.startsWith(taskFolder)).map(([path,state])=>({path,status:state})).sort((a,b)=>a.path.localeCompare(b.path))};
}

export type MergeInfo = {
  status:"found"|"missing"|"failed";
  /** The merge commit, main's HEAD before it (its first parent) and what it changed there. */
  commit:string|null; base:string|null; subject:string|null; changed:ChangedFile[];
  /** The commit is in the current history of the base checkout's branch. */
  inMain:boolean;
  reason:string|null;
};

/**
 * Finds the merge commit an attempt made in the base checkout, by the commit given or by the attempt trailer every merge
 * carries, and says what it changed. How a task accepted before the record existed is rolled back to a named state.
 */
export async function mergeInfo(input:{basePath:string;commit?:string;attemptId?:string}):Promise<MergeInfo> {
  const none = (status:MergeInfo["status"], reason:string|null):MergeInfo => ({status,commit:null,base:null,subject:null,changed:[],inMain:false,reason});
  let commit = input.commit??null;
  if(commit&&!SHA.test(commit)) return none("failed","commit is not a full commit id");
  if(!commit) {
    if(!input.attemptId) return none("failed","give a commit or an attempt");
    const trailer=ATTEMPT_TRAILER(input.attemptId);
    const found=await git(input.basePath,["log","-n","200","--format=%H%x1f%B%x1e","--fixed-strings",`--grep=${trailer}`,"HEAD"]);
    if(!found.ok) return none("failed",found.reason);
    for(const entry of found.stdout.split("\x1e")) {
      const [sha,body=""]=entry.split("\x1f");
      // Matched line by line: a fixed-string grep alone takes `a10` for `a1`.
      if(sha?.trim()&&body.split("\n").some((line)=>line.trim()===trailer)) { commit=sha.trim(); break; }
    }
    if(!commit) return none("missing",`no commit in ${input.basePath} carries ${trailer}`);
  }
  const parents=await git(input.basePath,["rev-list","--parents","-n","1",commit]);
  if(!parents.ok) return none("missing",parents.reason);
  const [, first] = parents.stdout.trim().split(/\s+/);
  if(!first||!SHA.test(first)) return none("failed","the commit has no parent to roll back to");
  const subject=(await git(input.basePath,["log","-n","1","--format=%s",commit])).stdout.trim()||null;
  const inMain=(await git(input.basePath,["merge-base","--is-ancestor",commit,"HEAD"])).ok;
  return {status:"found",commit,base:first,subject,changed:await changedBetween(input.basePath,first,commit),inMain,reason:null};
}

export type RevertResult = {
  status:"reverted"|"conflict"|"empty"|"failed";
  /** The revert commits made in the worktree, in order. */
  commits:string[];
  /** On a conflict: the files that cannot be reverted cleanly, and the later commits that touch them. */
  conflicts:string[];
  later:Array<{sha:string;subject:string;files:string[]}>;
  reason:string|null;
};

/**
 * `git revert` of the given commits (newest first) in the worktree, never a reset or a force. A merge commit is
 * reverted against its first parent (main as it was). A conflict undoes the whole attempt and names the files and the
 * later commits touching them: nothing is guessed, the caller refuses with that next step.
 */
export async function revertCommitsInWorktree(input:{worktreePath:string;commits:string[]}):Promise<RevertResult> {
  const result = (status:RevertResult["status"], extra:Partial<RevertResult>={}):RevertResult => ({status,commits:[],conflicts:[],later:[],reason:null,...extra});
  if(!input.commits.length||input.commits.some((commit)=>!SHA.test(commit))) return result("failed",{reason:"commits must be full commit ids"});
  const made:string[]=[];
  for(const commit of input.commits) {
    const parents=(await git(input.worktreePath,["rev-list","--parents","-n","1",commit])).stdout.trim().split(/\s+/);
    const merge=parents.length>2;
    const reverted=await git(input.worktreePath,[...await identity(input.worktreePath),"revert","--no-edit",...(merge?["-m","1"]:[]),commit]);
    if(reverted.ok) { made.push((await git(input.worktreePath,["rev-parse","HEAD"])).stdout.trim()); continue; }
    const unmerged=await git(input.worktreePath,["diff","--name-only","--diff-filter=U"]);
    const conflicts=unmerged.ok?unmerged.stdout.split("\n").map((line)=>line.trim()).filter(Boolean):[];
    const nothing=/nothing to commit|previous cherry-pick is now empty|The previous cherry-pick/i.test(`${reverted.reason}`)&&!conflicts.length;
    await git(input.worktreePath,["revert","--abort"]);
    // The caller discards this scratch worktree on anything but "reverted", so no half-reverted task is ever merged.
    if(nothing) return result("empty",{reason:`${commit.slice(0,12)} is already undone in this history`});
    if(!conflicts.length) return result("failed",{reason:`git revert failed: ${reverted.reason.split("\n").slice(-3).join(" ")}`});
    const later=new Map<string,{sha:string;subject:string;files:string[]}>();
    for(const file of conflicts.slice(0,20)) {
      const log=await git(input.worktreePath,["log","--format=%H%x1f%s","--no-merges",`${commit}..HEAD`,"--",file]);
      for(const line of log.ok?log.stdout.split("\n").filter(Boolean):[]) {
        const [sha,subject=""]=line.split("\x1f");
        const entry=later.get(sha!)??{sha:sha!,subject,files:[]};
        entry.files.push(file);
        later.set(sha!,entry);
      }
    }
    return result("conflict",{conflicts,later:[...later.values()].slice(0,10),reason:`reverting ${commit.slice(0,12)} conflicts in ${conflicts.slice(0,5).join(", ")}`});
  }
  return result("reverted",{commits:made});
}
