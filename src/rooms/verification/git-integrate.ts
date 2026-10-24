import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { appendFile, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { spawnAsync } from "@lane-pilot/kit";
import { isBookkeepingPath } from "@lane-pilot/settings-catalog";
import { matchOwnsPath } from "@lane-pilot/kit";
import { REPLAY_CHECK_FAILED } from "../runs";
import { isAllowedProjectLifePath } from "../project-life";

export type GitIntegration = {
  status:"merged"|"up-to-date"|"conflict"|"failed"|"busy";
  commit:string|null;
  conflicts:string[];
  reason:string|null;
  /** With «busy»: what the integration holding the base checkout merges (its commit message). */
  holder?:string|null;
  /** The attempt was replayed on a main that had moved, and merged without another writer turn. */
  rebased?:boolean;
  /** Workspace packages rebuilt in the base checkout after the merge, with how each build ended. */
  rebuilt?:Array<{dir:string;ok:boolean;detail:string|null}>;
  /** With «conflict» and no files: the task's checks that went red on the attempt replayed on the moved main. */
  checks?:ReplayCheck[];
  /** With «merged»: main's HEAD before the merge (the merge commit's first parent), and what the merge changed there, deletions included. */
  base?:string|null;
  changed?:ChangedFile[];
};

/** One file a change touched: A added, M modified, D deleted, T type changed. */
export type ChangedFile = {path:string;status:string};

/** `git diff --name-status` between two commits, deletions included (SMA wall 4: a rollback names what it undoes). */
export async function changedBetween(cwd:string,from:string,to:string):Promise<ChangedFile[]> {
  const diff=await git(cwd,["diff","--name-status","-z","--no-renames",from,to]);
  if(!diff.ok) return [];
  const parts=diff.stdout.split("\0").filter(Boolean);
  const files:ChangedFile[]=[];
  for(let i=0;i+1<parts.length;i+=2) files.push({status:parts[i]![0]!,path:parts[i+1]!});
  return files;
}

export type ReplayCheck = {command:string;exitCode:number;stdout:string;stderr:string};
/** What the checks run on the replayed attempt said: green, or the checks that are red. A check that could not run is no red. */
export type ReplayCheckOutcome = {ok:true} | {ok:false;failed:ReplayCheck[]};

/** The base checkout is held by a live integration; the caller waits and tries again instead of failing. */
export class BaseLockBusyError extends Error {
  constructor(readonly holder:string|null) {
    super(`another writer integration holds the base checkout${holder?`: ${holder}`:""}`);
    this.name="BaseLockBusyError";
  }
}

const FALLBACK_IDENTITY = ["-c", "user.name=Lane Pilot writer", "-c", "user.email=lane-pilot@localhost"];

/** Lane Pilot's per-task folder; never committed, never produced, never an owns_paths hit. The leading double star
 * is what makes the one line match at any depth (a pattern with a middle slash would be anchored to the repo root
 * and miss a workspace that is a subfolder — the real-git test caught exactly that). */
export const TASK_FOLDER_EXCLUDE = "**/.agents/plans/items/";

export function taskFolderRel(taskId:string):string|null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) return null;
  return `.agents/plans/items/${taskId}`;
}

/**
 * The shell that appends the task-folder exclude line to the repository's real info/exclude, which git itself
 * resolves (`--git-path`): a workspace that is a repo subfolder gets no stray `.git`, and a linked worktree's
 * shared exclude gets the line. Idempotent POSIX sh; run on the workspace's host with cwd at the workspace.
 */
export function appendExcludeCommand(line:string):string {
  const quoted=line.replace(/'/g,"'\\''");
  return `f=$(git rev-parse --git-path info/exclude) || exit 1
grep -qxF '${quoted}' "$f" 2>/dev/null || { mkdir -p "$(dirname "$f")" && printf '%s\\n' '${quoted}' >> "$f"; }`;
}

/** What ensureExcludeLinesCommand prints: «lp:added <line>» for each line it appended, «lp:not-git» outside a repository. */
export const EXCLUDE_ADDED = "lp:added ";
export const EXCLUDE_NOT_GIT = "lp:not-git";

/**
 * Like appendExcludeCommand for several lines at once, telling which ones were missing and are now there. A last line
 * without a newline is closed first, so the first appended line is not glued to it. Idempotent POSIX sh.
 */
export function ensureExcludeLinesCommand(lines:readonly string[]):string {
  const quoted=lines.map((line)=>`'${line.replace(/'/g,"'\\''")}'`).join(" ");
  return `f=$(git rev-parse --git-path info/exclude 2>/dev/null) || { echo '${EXCLUDE_NOT_GIT}'; exit 0; }
mkdir -p "$(dirname "$f")" || exit 1
for l in ${quoted}; do
  grep -qxF -- "$l" "$f" 2>/dev/null && continue
  { [ ! -s "$f" ] || [ -z "$(tail -c1 "$f")" ] || printf '\\n' >> "$f"; } && printf '%s\\n' "$l" >> "$f" && printf '${EXCLUDE_ADDED}%s\\n' "$l"
done`;
}

export async function persistTaskFolder(input:{
  taskId:string; plan:string;
  /** Appends the exclude line to the repo's real info/exclude on the workspace's host; a failure skips only the line. */
  exclude?:(line:string)=>Promise<void>;
  writeFile:(relativePath:string, content:string)=>Promise<void>;
}):Promise<{folder:string}|null> {
  const folder = taskFolderRel(input.taskId);
  if (!folder) return null;
  if (input.exclude) {
    try { await input.exclude(TASK_FOLDER_EXCLUDE); }
    catch (cause) {
      console.warn(`lane-pilot: skipped the task-folder exclude line: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  const plan = input.plan.endsWith("\n") ? input.plan : `${input.plan}\n`;
  await input.writeFile(`${folder}/PLAN.md`, plan);
  return { folder };
}

/**
 * A git process that hit <git-dir>/index.lock names it only sometimes (macOS prints the path; Linux git 2.43 says
 * just «Unable to write index»), so the lock is named here and every such failure classes as infra, not as the
 * task's. `git rev-parse` itself never writes the index, so it answers even while the lock stands.
 */
export async function withIndexLockNote(cwd:string,reason:string):Promise<string> {
  if (reason.includes("index.lock")) return reason;
  const dir=await spawnAsync("git",["rev-parse","--absolute-git-dir"],{cwd,timeout:10_000,maxBuffer:1_000_000});
  const gitDir=dir.status===0?dir.stdout.trim():"";
  if (!gitDir||!existsSync(join(gitDir,"index.lock"))) return reason;
  return `${reason} (index.lock present)`;
}

export async function git(cwd:string,args:string[]) {
  const result=await spawnAsync("git",args,{cwd,timeout:60_000,maxBuffer:4_000_000});
  if(result.error) return {ok:false as const,stdout:"",reason:result.error.message};
  if(result.status!==0) return {ok:false as const,stdout:result.stdout??"",reason:await withIndexLockNote(cwd,(result.stderr||result.stdout||`git exited ${result.status}`).trim())};
  return {ok:true as const,stdout:result.stdout,reason:""};
}

/**
 * A linked worktree's folder whose `.git` names an admin dir that git no longer gives to it. `git worktree remove` that
 * stopped half way drops the admin dir and leaves the folder; git then hands the free admin name to the next worktree,
 * and a git command in the old folder works on the new worktree's index (SelfyStudio 2026-10-24: a cleanup's `git add -A`
 * in a 20.10 leftover wrote its half-deleted tree into site-seo-blog-authors' index — 14 880 files «deleted», the
 * attempt blocked as out of scope). Null when the folder is no linked worktree at all.
 */
export async function orphanedWorktree(path:string):Promise<{top:string;adminDir:string}|null> {
  let top=path;
  for(;;) {
    const entry=await lstat(join(top,".git")).catch(()=>null);
    if(entry) { if(!entry.isFile()) return null; break; }
    const up=dirname(top);
    if(up===top) return null;
    top=up;
  }
  const adminDir=(await readFile(join(top,".git"),"utf8").catch(()=>"")).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if(!adminDir) return null;
  const back=(await readFile(join(adminDir,"gitdir"),"utf8").catch(()=>"")).trim();
  const [mine,theirs]=await Promise.all([realpath(join(top,".git")).catch(()=>join(top,".git")),back?realpath(back).catch(()=>back):Promise.resolve("")]);
  return mine===theirs?null:{top,adminDir};
}

/** Lane Pilot's own worktree root on this host (`~/.lane-pilot/worktrees`), or null when `path` is not under it. */
function laneWorktreeRootOf(path:string):string|null {
  let dir=path;
  for(;;) {
    if(basename(dir)==="worktrees"&&basename(dirname(dir))===".lane-pilot") return dir;
    const up=dirname(dir);
    if(up===dir) return null;
    dir=up;
  }
}

/**
 * An orphaned Lane Pilot worktree folder is cut off from git (its `.git` renamed) so no command reaches another
 * worktree's index through it, then removed: what is left is the rest of a removal that already started.
 */
async function retireOrphanedWorktree(orphan:{top:string;adminDir:string}):Promise<boolean> {
  await rename(join(orphan.top,".git"),join(orphan.top,".git.orphaned")).catch(()=>undefined);
  if(!laneWorktreeRootOf(orphan.top)) return false;
  console.warn(`lane-pilot: removed the orphaned worktree folder ${orphan.top} (its .git named ${orphan.adminDir}, which git gave to another worktree)`);
  await rm(orphan.top,{recursive:true,force:true}).catch(()=>undefined);
  await removeEmptyWorktreeParent(orphan.top);
  return true;
}

/** Other folders under Lane Pilot's worktree root whose `.git` names the admin dir a new worktree just got are retired. */
async function retireCollidingWorktrees(targetPath:string):Promise<void> {
  const root=laneWorktreeRootOf(targetPath);
  if(!root) return;
  const own=await realpath(targetPath).catch(()=>targetPath);
  for(const attempt of await readdir(root).catch(()=>[] as string[])) {
    for(const name of await readdir(join(root,attempt)).catch(()=>[] as string[])) {
      const folder=join(root,attempt,name);
      if((await realpath(folder).catch(()=>folder))===own) continue;
      const orphan=await orphanedWorktree(folder);
      if(orphan&&orphan.top===folder) await retireOrphanedWorktree(orphan);
    }
  }
}

/** The repository's own identity when set, otherwise a writer identity, so commits never fail on a bare host. */
export async function identity(cwd:string):Promise<string[]> {
  const email=await git(cwd,["config","user.email"]);
  return email.ok&&email.stdout.trim()?[]:FALLBACK_IDENTITY;
}

/** True while the process that took a lock still runs; a host process killed mid-merge leaves its lock behind. */
function ownerAlive(pid:number):boolean {
  try { process.kill(pid,0); return true; }
  catch(error) { return (error as NodeJS.ErrnoException).code==="EPERM"; }
}

/**
 * A git process killed mid-write leaves <git-dir>/index.lock, and every later git command in that checkout fails on it
 * (a deploy waited 5+ minutes on one, 2026-10-04). A lock older than 60 s that no live process holds is renamed aside,
 * never deleted. Without lsof nothing proves it is free, so only a lock older than 10 minutes counts. A fresh lock is a live git.
 */
export async function recoverStaleGitLock(cwd:string):Promise<string|null> {
  const dir=await git(cwd,["rev-parse","--absolute-git-dir"]);
  if(!dir.ok||!dir.stdout.trim()) return null;
  const lock=join(dir.stdout.trim(),"index.lock");
  const info=await stat(lock).catch(()=>null);
  const age=info?Date.now()-info.mtimeMs:0;
  if(!info||age<=60_000) return null;
  const held=await spawnAsync("lsof",[lock],{timeout:10_000});
  const lsofRan=!held.error&&(held.status===0||held.status===1);
  if(lsofRan?held.status===0&&held.stdout.trim()!=="":age<=600_000) return null;
  const aside=`${lock}.stale-${Date.now()}`;
  if(!await rename(lock,aside).then(()=>true,()=>false)) return null;
  console.warn(`lane-pilot: moved stale git lock ${lock} (${Math.round(age/1000)}s old, no live holder) to ${aside}`);
  return aside;
}

/**
 * A merge cut off midway (its process killed) leaves MERGE_HEAD, and every later merge refuses to start. Under the
 * integration lock nobody else merges here, so one older than 10 minutes is aborted.
 */
export async function abortStaleMerge(cwd:string):Promise<boolean> {
  const dir=await git(cwd,["rev-parse","--absolute-git-dir"]);
  if(!dir.ok||!dir.stdout.trim()) return false;
  const info=await stat(join(dir.stdout.trim(),"MERGE_HEAD")).catch(()=>null);
  if(!info||Date.now()-info.mtimeMs<=600_000) return false;
  const aborted=(await git(cwd,["merge","--abort"])).ok;
  console.warn(`lane-pilot: ${aborted?"aborted":"could not abort"} a merge left unfinished in ${cwd} (${Math.round((Date.now()-info.mtimeMs)/60_000)} min old)`);
  return aborted;
}

/**
 * One integration at a time per base checkout. The lock names its process; a lock whose process is gone
 * (the host restarted mid-merge) is taken over at once, and any lock older than 10 minutes is stale.
 */
export async function withBaseLock<T>(basePath:string,work:()=>T|Promise<T>,label="",waitMs=120_000):Promise<T> {
  // In a worktree .git is a file; the lock lives in that checkout's own git directory.
  const gitDir=await git(basePath,["rev-parse","--absolute-git-dir"]);
  const lock=join(gitDir.ok&&gitDir.stdout.trim()?gitDir.stdout.trim():join(basePath,".git"),"lane-pilot-integrate.lock");
  const deadline=Date.now()+waitMs;
  for(;;) {
    // The owner file: the pid on the first line, then what this integration merges, for whoever waits.
    try { await mkdir(lock); await writeFile(join(lock,"owner"),`${process.pid}\n${label.split("\n")[0]!.slice(0,300)}`); break; }
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      const info=await stat(lock).catch(()=>null);
      const ownerText=await readFile(join(lock,"owner"),"utf8").catch(()=>"");
      const owner=Number.parseInt(ownerText,10);
      // A lock without a pid is either being created right now, or its process was stopped before writing
      // the pid (a plugin reload between mkdir and the write), or it was left by an older Lane Pilot.
      const orphaned=Number.isInteger(owner)&&owner>0&&owner!==process.pid&&!ownerAlive(owner);
      const legacy=!Number.isInteger(owner)&&info!==null&&Date.now()-info.mtimeMs>5_000;
      if(orphaned||legacy||(info&&Date.now()-info.mtimeMs>600_000)) { await rm(lock,{recursive:true,force:true}); continue; }
      if(Date.now()>deadline) throw new BaseLockBusyError(ownerText.split("\n")[1]?.trim()||null);
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
  }
  // Awaited, so an async task keeps the lock until it finishes.
  try { return await work(); } finally { await rm(lock,{recursive:true,force:true}); }
}

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
  /** Run once the attempt was replayed on a moved main, before the merge (a semantic clash shows only there). */
  replayCheck?:()=>Promise<ReplayCheckOutcome>;
  /** How long a merge stopped by another git's fresh index.lock in the base waits for that lock to go before it gives up. */
  indexLockWaitMs?:number;
  /** How long machine-written files staged in the base's index (a stage between `git add` and `git commit`) get to be committed by their stager; then they are committed here. */
  stagedWaitMs?:number}):Promise<GitIntegration> {
  const fail=(reason:string):GitIntegration=>({status:"failed",commit:null,conflicts:[],reason});
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
      // Main moved while the writer worked: replay the attempt on the current main first. Clean, it merges without
      // another writer turn; a real conflict is left as it was and the merge below reports it for the free redo.
      // The attempt's own branch only: Lane Pilot's lane/<attempt> and the BB-managed bb/<attempt> worktree (one per attempt too).
      const rebased=(branch.startsWith("lane/")||branch.startsWith("bb/"))&&before?await rebaseOntoBase(input.worktreePath,before):null;
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
          return {status:"conflict",commit:null,conflicts:[],reason:`${REPLAY_CHECK_FAILED}: verification failed (${replay.failed.map((check)=>check.command).join(", ")})`,checks:replay.failed};
        }
      }
      const merged=await merge(input.basePath,rebased??sha,input.message,input.bookkeeping,input.ownsPaths,input.indexLockWaitMs);
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

/** Where a Lane chat folder sits in its git checkout: at the repo root, or nested inside a larger repo. */
export async function workspaceGitLayout(workspacePath:string):Promise<
  {ok:true;repoTop:string;nested:boolean;prefix:string} | {ok:false;reason:string}
> {
  const top=await git(workspacePath,["rev-parse","--show-toplevel"]);
  if(!top.ok||!top.stdout.trim()) return {ok:false,reason:top.reason||"not a git checkout"};
  const repoTop=top.stdout.trim();
  const [workspaceReal,topReal]=await Promise.all([
    realpath(workspacePath).catch(()=>workspacePath),
    realpath(repoTop).catch(()=>repoTop),
  ]);
  const prefix=relative(topReal,workspaceReal).replace(/\\/g,"/");
  if(prefix.startsWith("..")) return {ok:false,reason:"workspace is outside its git checkout"};
  const nested=prefix!==""&&prefix!==".";
  return {ok:true,repoTop,nested,prefix:nested?prefix:""};
}

/**
 * Creates Lane Pilot's own worktree of a section repository on a fresh lane/<name> branch from its HEAD. A chat folder
 * nested in a larger repo gets a worktree of that repo; `path` is then the same subfolder inside it, where the writer works.
 */
export async function createWorktree(input:{basePath:string;targetPath:string;name:string;
  /** Start from this commit instead of the base checkout's HEAD (a reverify checks out the merged change, a revert compares with its base). */
  commit?:string}):Promise<{status:"ready"|"failed";path:string|null;branch:string|null;reason:string|null;
  /** The commit the worktree starts from: the attempt's base, recorded so a rollback can name it. */
  baseSha:string|null}> {
  const layout=await workspaceGitLayout(input.basePath);
  if(!layout.ok) return {status:"failed",path:null,branch:null,baseSha:null,reason:`not a git checkout: ${layout.reason}`};
  const repoRoot=layout.nested?layout.repoTop:input.basePath;
  const branch=`lane/${input.name}`;
  await mkdir(join(input.targetPath,".."),{recursive:true});
  await recoverStaleGitLock(repoRoot);
  const added=await git(repoRoot,["worktree","add","-q","-b",branch,input.targetPath,input.commit??"HEAD"]);
  if(!added.ok) return {status:"failed",path:null,branch:null,baseSha:null,reason:added.reason};
  // git may have given this worktree the admin name a half-removed old folder still points at.
  await retireCollidingWorktrees(input.targetPath);
  const head=await git(input.targetPath,["rev-parse","HEAD"]);
  const path=layout.nested?join(input.targetPath,layout.prefix):input.targetPath;
  // A subfolder with no tracked file yet is not in the checkout.
  if(layout.nested) await mkdir(path,{recursive:true});
  return {status:"ready",path,branch,reason:null,baseSha:head.ok&&/^[a-f0-9]{40,64}$/.test(head.stdout.trim())?head.stdout.trim():null};
}

/** Files only machines write (receipts, episodes, locks): never the work of a task, whatever owns_paths names. */
const MACHINE_WRITTEN = [".agents/runs/", ".bb/chats/", "notes/lock/", ".agents/memory/episodes/"];
/** A bookkeeping path a task's owns_paths names; a catch-all pattern owns no particular file. */
function ownedBookkeeping(rel:string, owns:readonly string[]):boolean {
  const clean = rel.replace(/^\.\//, "");
  if (MACHINE_WRITTEN.some((prefix) => clean.startsWith(prefix))) return false;
  return owns.some((pattern) => pattern.trim() !== "**" && matchOwnsPath(clean, pattern));
}

/**
 * Bookkeeping folders sit in the repository's info/exclude (activation), so `git add -A` leaves out a file the task
 * owns there (`.agents/reports/audit.md`) and the work is lost with the worktree. Such files are added by force.
 */
async function stageOwnedBookkeeping(worktreePath:string, owns:readonly string[], extra:readonly string[]):Promise<void> {
  const ignored=await git(worktreePath,["ls-files","--others","--ignored","--exclude-standard","-z"]);
  if(!ignored.ok) return;
  const files=ignored.stdout.split("\0").filter((file)=>file&&isBookkeepingPath(file,extra)&&ownedBookkeeping(file,owns));
  if(files.length) await git(worktreePath,["add","-f","--",...files]);
}

/** Paths staged in the base checkout's index (relative to the repository top), or null when git cannot say. */
async function stagedPaths(basePath:string):Promise<string[]|null> {
  const staged=await git(basePath,["diff","--cached","--name-only","-z","HEAD"]);
  return staged.ok?staged.stdout.split("\0").filter(Boolean):null;
}

/**
 * Git's ort strategy refuses every merge while the index differs from HEAD, whatever the merge touches. The project-life
 * stage works in this checkout and stages its files (PROGRESS, CHANGELOG, plan items) a moment before it commits them
 * (drill 2026-10-07: the merge landed in that moment and failed as `merge_failed`). Machine-written files staged in the
 * base get `waitMs` to be committed by whoever staged them; still staged, they are committed here, as staged, under the
 * integration lock. Nothing is discarded, unstaged edits stay in the working tree, and a staged file that is anyone's
 * work (an owner's product file) is left alone: the merge then reports it as a dirty base.
 */
async function settleStagedBookkeeping(basePath:string, extra:readonly string[], waitMs=20_000):Promise<void> {
  let paths=await stagedPaths(basePath);
  if(!paths?.length) return;
  const deadline=Date.now()+waitMs;
  while(paths?.length&&Date.now()<deadline) {
    await new Promise((resolve)=>setTimeout(resolve,250));
    paths=await stagedPaths(basePath);
  }
  if(!paths?.length) return;
  const prefix=(await git(basePath,["rev-parse","--show-prefix"])).stdout.trim();
  const machineWritten=(path:string)=>path.startsWith(prefix)&&(isBookkeepingPath(path.slice(prefix.length),extra)||isAllowedProjectLifePath(path.slice(prefix.length)));
  if(!paths.every(machineWritten)) return;
  const committed=await git(basePath,[...await identity(basePath),"commit","-q","-m","chore(progress): settle bookkeeping staged in the base before a merge"]);
  if(committed.ok) console.warn(`lane-pilot: committed ${paths.length} machine-written file(s) left staged in ${basePath} before the merge: ${paths.slice(0,5).join(", ")}`);
  else console.warn(`lane-pilot: could not commit the staged bookkeeping in ${basePath}: ${committed.reason.split("\n").slice(-3).join(" ")}`);
}

/**
 * The commit to merge in place of the writer's: its tree with every bookkeeping file (src/bookkeeping-paths.ts) set to
 * what main has. A hook or sibling agent edits those files in the base checkout meanwhile, and a merge that touched
 * them stopped on «local changes would be overwritten» or on a conflict nobody could redo away.
 */
async function resolveBookkeepingToMain(basePath:string, sha:string, extra:readonly string[], owns:readonly string[]=[]):Promise<string> {
  const raw = await git(basePath, ["diff", "--raw", "--no-abbrev", "-z", "--no-renames", "HEAD", sha]);
  if (!raw.ok) return sha;
  const prefix = (await git(basePath, ["rev-parse", "--show-prefix"])).stdout.trim();
  const parts = raw.stdout.split("\0");
  const entries:string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = /^:(\d+) \d+ ([0-9a-f]+) [0-9a-f]+ \w+$/.exec(parts[i] ?? "");
    const path = parts[i + 1]!;
    if (!meta || !path.startsWith(prefix) || !isBookkeepingPath(path.slice(prefix.length), extra)) continue;
    // A bookkeeping file the task owns (expected output `.agents/reports/audit.md`) is the task's work, not a hook's noise.
    if (ownedBookkeeping(path.slice(prefix.length), owns)) continue;
    // main's version (old side of the diff); a file main lacks is removed from the merged tree.
    entries.push(/^0+$/.test(meta[2]!) ? `0 ${meta[2]}\t${path}` : `${meta[1]} ${meta[2]}\t${path}`);
  }
  if (!entries.length) return sha;

  const gitDir = await git(basePath, ["rev-parse", "--absolute-git-dir"]);
  const dir = gitDir.ok && gitDir.stdout.trim() ? gitDir.stdout.trim() : join(basePath, ".git");
  const tempIndex = join(dir, `temp-idx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  const run = (args:string[], input?:string) => spawnAsync("git", args, { cwd: basePath, env, timeout: 30_000, input });

  try {
    if ((await run(["read-tree", sha])).status !== 0) return sha;
    if ((await run(["update-index", "-z", "--index-info"], `${entries.join("\0")}\0`)).status !== 0) return sha;
    const writeTree = await run(["write-tree"]);
    if (writeTree.status !== 0 || !writeTree.stdout.trim()) return sha;
    const commitTree = await git(basePath, [...await identity(basePath), "commit-tree", writeTree.stdout.trim(), "-p", sha, "-m", "resolve bookkeeping to main"]);
    return commitTree.ok && commitTree.stdout.trim() ? commitTree.stdout.trim() : sha;
  } finally {
    try { unlinkSync(tempIndex); } catch {}
  }
}

/** git's words for a command that found <git-dir>/index.lock taken (withIndexLockNote adds the lock where git names none). */
const INDEX_LOCKED=/index\.lock|unable to write (new )?index/i;

/** Waits until nobody holds <git-dir>/index.lock; false when it still stands at the deadline. */
async function indexLockGone(cwd:string,waitMs:number):Promise<boolean> {
  const dir=await git(cwd,["rev-parse","--absolute-git-dir"]);
  if(!dir.ok||!dir.stdout.trim()) return false;
  const lock=join(dir.stdout.trim(),"index.lock");
  const deadline=Date.now()+waitMs;
  while(existsSync(lock)) {
    if(Date.now()>deadline) return false;
    await new Promise((resolve)=>setTimeout(resolve,200));
  }
  return true;
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

/**
 * A git worktree has no ignored dependencies; link the base checkout's node_modules so the
 * writer's checks run, and keep the link out of git through the shared info/exclude.
 */
const installing=new Map<string,Promise<void>>();

/**
 * One `npm ci` per checkout across processes: background jobs run in their own process, so the map above no longer
 * covers two worktree preparations of the same base. The loser waits for the winner and finds node_modules in place.
 */
async function withInstallLock(basePath:string,work:()=>Promise<void>):Promise<void> {
  const lock=join(tmpdir(),`lane-pilot-npm-ci-${createHash("sha1").update(basePath).digest("hex").slice(0,16)}.lock`);
  const deadline=Date.now()+600_000;
  let held=false;
  while(!held) {
    try { await mkdir(lock); await writeFile(join(lock,"owner"),String(process.pid)); held=true; }
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      const owner=Number.parseInt(await readFile(join(lock,"owner"),"utf8").catch(()=>""),10);
      const info=await stat(lock).catch(()=>null);
      if((Number.isInteger(owner)&&owner>0&&!ownerAlive(owner))||(info&&Date.now()-info.mtimeMs>900_000)) { await rm(lock,{recursive:true,force:true}); continue; }
      if(Date.now()>deadline) break;
      await new Promise((resolve)=>setTimeout(resolve,1_000));
    }
  }
  try { await work(); } finally { if(held) await rm(lock,{recursive:true,force:true}); }
}

/**
 * Installs a project's npm dependencies once, in the main checkout, from its lockfile. `npm ci` never
 * rewrites package-lock.json, so a writer no longer has to run `npm install` and trip the owns check,
 * and the offline verification sandbox finds the packages already in place.
 */
async function installBaseDependencies(basePath:string):Promise<void> {
  if((await stat(join(basePath,"node_modules")).catch(()=>null))?.isDirectory()) return;
  if(!(await stat(join(basePath,"package-lock.json")).catch(()=>null))?.isFile()) return;
  const install=async()=>{
    if((await stat(join(basePath,"node_modules")).catch(()=>null))?.isDirectory()) return;
    await spawnAsync("npm",["ci","--no-audit","--no-fund"],{cwd:basePath,timeout:540_000,maxBuffer:16<<20});
  };
  const running=installing.get(basePath)??withInstallLock(basePath,install).finally(()=>installing.delete(basePath));
  installing.set(basePath,running);
  await running;
}

/**
 * Rebuilds, in a checkout, the workspace packages changed between two commits that are consumed through their
 * build output (they have dist/ and a build script). In the base checkout after a merge: a writer's worktree copies
 * dist/ from there; left stale, the next writer's typecheck failed until someone rebuilt main by hand (SelfyStudio,
 * 2026-10-02). In a worktree after the replay on main: its dist/ is its own copy and does not follow the replayed sources.
 */
async function rebuildChangedPackages(basePath:string,before:string,after:string):Promise<Array<{dir:string;ok:boolean;detail:string|null}>> {
  const diff=await git(basePath,["diff","--name-only",`${before}..${after}`]);
  if(!diff.ok) return [];
  const changed=diff.stdout.split("\n").map((line)=>line.trim()).filter(Boolean);
  const out:Array<{dir:string;ok:boolean;detail:string|null}>=[];
  for(const dir of await workspaceDirs(basePath)) {
    // Markdown is no build input: a docs merge must not rebuild every package whose docs/ it touched.
    if(!changed.some((file)=>file.startsWith(`${dir}/`)&&!file.startsWith(`${dir}/dist/`)&&!file.endsWith(".md"))) continue;
    if(!(await stat(join(basePath,dir,"dist")).catch(()=>null))?.isDirectory()) continue;
    const manifest=await readFile(join(basePath,dir,"package.json"),"utf8").then((text)=>JSON.parse(text) as {scripts?:Record<string,string>}).catch(()=>null);
    if(!manifest?.scripts?.build) continue;
    const run=await spawnAsync("npm",["run","build"],{cwd:join(basePath,dir),timeout:300_000,maxBuffer:16<<20});
    const ok=run.status===0;
    out.push({dir,ok,detail:ok?null:`${run.error?.message??""}${(run.stderr||run.stdout||"").trim().split("\n").slice(-6).join("\n")}`.slice(0,800)});
  }
  return out;
}

/**
 * The repository's own packages that are no declared workspace (an app in a subfolder with its own package.json and its own install):
 * the folders of the package.json files the worktree tracks, that have a node_modules in the base. Only the root and the workspaces were
 * mirrored, so a check in such a folder ran without its dependencies in every throwaway worktree: FeedGen's `cd intro-video && npx tsc`
 * fetched a bare tsc and failed TS2688 (no 'web' types) at main and at its own merge commit alike, and the run-goal check called a run
 * of two accepted tasks red (lprun_6163b96a, 2026-10-23).
 */
async function nestedPackageDirs(baseReal:string,worktreePath:string,workspaces:readonly string[]):Promise<string[]> {
  const listed=await git(worktreePath,["ls-files","-z","--",":(glob)**/package.json"]);
  if(!listed.ok) return [];
  const taken=new Set(workspaces);
  const dirs:string[]=[];
  for(const file of listed.stdout.split("\0").filter(Boolean)) {
    const dir=dirname(file);
    if(dir==="."||taken.has(dir)||dir.split("/").length>3||dir.split("/").includes("node_modules")) continue;
    if((await stat(join(baseReal,dir,"node_modules")).catch(()=>null))?.isDirectory()) dirs.push(dir);
    if(dirs.length>=20) break;
  }
  return [...new Set(dirs)].sort();
}

/** The workspace folders of a monorepo (`apps/*`, a literal path), from the base package.json; [] when none. */
async function workspaceDirs(basePath:string):Promise<string[]> {
  const manifest=await readFile(join(basePath,"package.json"),"utf8").then((text)=>JSON.parse(text) as {workspaces?:string[]|{packages?:string[]}}).catch(()=>null);
  const patterns=Array.isArray(manifest?.workspaces)?manifest.workspaces:manifest?.workspaces?.packages??[];
  const dirs:string[]=[];
  for(const pattern of patterns) {
    if(typeof pattern!=="string"||pattern.startsWith("/")||pattern.includes("..")) continue;
    if(pattern.endsWith("/*")) {
      const parent=pattern.slice(0,-2);
      for(const name of await readdir(join(basePath,parent)).catch(()=>[] as string[])) {
        if(!name.startsWith(".")&&(await stat(join(basePath,parent,name,"package.json")).catch(()=>null))?.isFile()) dirs.push(join(parent,name));
      }
    } else if(!pattern.includes("*")&&(await stat(join(basePath,pattern,"package.json")).catch(()=>null))?.isFile()) dirs.push(pattern);
  }
  return [...new Set(dirs)].sort();
}

/**
 * Mirrors one node_modules folder entry by entry. A third-party package is a link to the base copy;
 * a workspace package (npm links it back into the repository) is re-pointed at the worktree's own
 * copy, so checks in the worktree import the writer's edits and not the base checkout's sources.
 */
/**
 * Tool caches inside node_modules (vite writes its bundled config to .vite-temp) get their own empty folder in the
 * worktree. Linked, they wrote into the base checkout, which the verification sandbox mounts read-only: SelfyStudio's
 * marketing vitest failed with EROFS on every attempt (2026-10-02).
 */
const NODE_MODULES_CACHE_DIRS = new Set([".vite-temp", ".vite", ".vitest", ".cache"]);
/**
 * Generated code a check rewrites (`prisma generate` writes `.prisma` and refreshes `@prisma/client`): copied,
 * not linked, so the worktree has the base's current client and the check can regenerate it. A link pointed
 * into the base checkout, which the sandbox mounts read-only: EROFS (SelfyStudio persistence-prisma typecheck).
 */
const NODE_MODULES_WRITABLE_COPIES = new Set([".prisma", "@prisma/client"]);
/**
 * What npm itself rewrites on every `npm install`: the bin links and its hidden lockfile. Linked, both sat in the base
 * checkout, which the verification sandbox does not let a check write: `npm install` in a fresh worktree died with
 * «EPERM symlink … node_modules/.bin/…», exit 255 (office-viewer studio-slides, 2026-10-17). `.bin` gets its own folder of
 * the base's links, kept verbatim (`../pkg/bin.js` then resolves in the worktree), and the lockfile its own copy.
 */
const NODE_MODULES_NPM_STATE = new Set([".bin", ".package-lock.json"]);

async function mirrorNodeModules(input:{baseReal:string;worktreePath:string;dir:string}):Promise<boolean> {
  const base=join(input.baseReal,input.dir,"node_modules"), target=join(input.worktreePath,input.dir,"node_modules");
  if(!(await stat(base).catch(()=>null))?.isDirectory()) return false;
  if(!(await stat(dirname(target)).catch(()=>null))?.isDirectory()||await lstat(target).catch(()=>null)) return false;
  const inRepo=(path:string)=>(path===input.baseReal||path.startsWith(`${input.baseReal}/`))&&!path.startsWith(`${base}/`);
  await mkdir(target);
  const linkEntry=async(rel:string[])=>{
    const source=join(base,...rel), destination=join(target,...rel);
    if(NODE_MODULES_WRITABLE_COPIES.has(rel.join("/"))) {
      await cp(source,destination,{recursive:true,dereference:true,errorOnExist:false}).catch(async()=>{ await mkdir(destination,{recursive:true}); });
      return;
    }
    const info=await lstat(source);
    if(info.isSymbolicLink()) {
      const real=await realpath(source).catch(()=>null);
      if(real&&inRepo(real)) { await symlink(join(input.worktreePath,relative(input.baseReal,real)),destination,"dir"); return; }
    }
    const followed=await stat(source).catch(()=>null);
    await symlink(source,destination,followed?.isDirectory()?"dir":"file");
  };
  for(const name of await readdir(base)) {
    if(NODE_MODULES_CACHE_DIRS.has(name)) { await mkdir(join(target,name)); continue; }
    if(NODE_MODULES_NPM_STATE.has(name)&&!(await lstat(join(base,name))).isSymbolicLink()) {
      await cp(join(base,name),join(target,name),{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:false});
      continue;
    }
    if(name.startsWith("@")&&!(await lstat(join(base,name))).isSymbolicLink()&&(await stat(join(base,name))).isDirectory()) {
      await mkdir(join(target,name));
      for(const child of await readdir(join(base,name))) await linkEntry([name,child]);
    } else {
      await linkEntry([name]);
    }
  }
  return true;
}

/** The checkout's real info/exclude, resolved by git itself: the repo root's, a linked worktree's shared one, or a subfolder workspace's. */
async function infoExcludePath(checkoutPath:string):Promise<string|null> {
  const path=await git(checkoutPath,["rev-parse","--git-path","info/exclude"]);
  if(!path.ok||!path.stdout.trim()) return null;
  const resolved=path.stdout.trim();
  return isAbsolute(resolved)?resolved:join(checkoutPath,resolved);
}

async function ensureInfoExclude(checkoutPath:string, extraLines:string[]):Promise<void> {
  const exclude=await infoExcludePath(checkoutPath);
  if(!exclude) return;
  const current=await readFile(exclude,"utf8").catch(()=>"");
  const missing=extraLines.filter((line)=>!current.split("\n").includes(line));
  if(!missing.length) return;
  await mkdir(join(exclude,".."),{recursive:true});
  await appendFile(exclude,`${current&&!current.endsWith("\n")?"\n":""}${missing.join("\n")}\n`);
}

async function copyTaskItems(basePath:string, worktreePath:string):Promise<void> {
  const src=join(basePath,".agents","plans","items");
  if(!(await stat(src).catch(()=>null))?.isDirectory()) return;
  const dest=join(worktreePath,".agents","plans","items");
  const srcReal=await realpath(src).catch(()=>src);
  const destReal=await realpath(dest).catch(()=>dest);
  if(srcReal===destReal) return;
  await mkdir(join(dest,".."),{recursive:true});
  // A file the repository tracks (a project-life commit added it) already sits in the worktree as committed: the base's
  // uncommitted edits of it are that stage's, and copied over it they went into the attempt's commit and blocked its merge.
  const tracked=new Set((await git(worktreePath,["ls-files","-z","--",".agents/plans/items"])).stdout.split("\0").filter(Boolean));
  await cp(src,dest,{recursive:true,dereference:false,errorOnExist:false,force:true,
    filter:(_from,to)=>!tracked.has(relative(worktreePath,to).replace(/\\/g,"/"))});
}

export async function prepareWorktree(input:{basePath:string;worktreePath:string}):Promise<{linked:string[]}> {
  await ensureInfoExclude(input.worktreePath, [TASK_FOLDER_EXCLUDE]);
  await copyTaskItems(input.basePath, input.worktreePath);
  await installBaseDependencies(input.basePath);
  const baseReal=await realpath(input.basePath).catch(()=>input.basePath);
  const workspaces=await workspaceDirs(baseReal);
  const nested=await nestedPackageDirs(baseReal,input.worktreePath,workspaces);
  const rootModules=(await stat(join(baseReal,"node_modules")).catch(()=>null))?.isDirectory()??false;
  if(await lstat(join(input.worktreePath,"node_modules")).catch(()=>null)||(!rootModules&&!nested.length)) return {linked:[]};
  const exclude=await infoExcludePath(input.worktreePath);
  if(!exclude) return {linked:[]};
  const current=await readFile(exclude,"utf8").catch(()=>"");
  // Tool caches the checks write (vitest's .vite/ inside a package) stay out of the writer's commit and of main.
  const missing=["/node_modules","node_modules/",".vite/",".vitest/",".turbo/",".parcel-cache/"].filter((line)=>!current.split("\n").includes(line));
  if(missing.length) {
    await mkdir(join(exclude,".."),{recursive:true});
    await appendFile(exclude,`${current&&!current.endsWith("\n")?"\n":""}${missing.join("\n")}\n`);
  }
  const linked:string[]=[];
  for(const workspace of ["",...workspaces,...nested]) {
    if(await mirrorNodeModules({baseReal,worktreePath:input.worktreePath,dir:workspace})) linked.push(workspace?join(workspace,"node_modules"):"node_modules");
  }
  // Workspace packages are consumed through their ignored build output (exports → dist/). A fresh
  // worktree has none, so every check importing a sibling package would fail; each worktree gets its
  // own copy, and a build inside the worktree never writes into the base checkout or another lane.
  // Nuxt apps also need their generated .nuxt/ (tsconfig, types): without it vitest stopped at
  // «Failed to load tsconfig '.nuxt/tsconfig.json'» in SelfyStudio's marketing app (2026-10-02).
  for(const workspace of workspaces) for(const generated of ["dist",".nuxt"]) {
    const dist=join(workspace,generated);
    if(!(await stat(join(baseReal,dist)).catch(()=>null))?.isDirectory()||await lstat(join(input.worktreePath,dist)).catch(()=>null)) continue;
    if(!(await git(baseReal,["check-ignore","-q",dist])).ok) continue;
    await cp(join(baseReal,dist),join(input.worktreePath,dist),{recursive:true,dereference:false,errorOnExist:false,force:true});
    linked.push(dist);
  }
  return {linked};
}

/**
 * Lane Pilot's worktrees sit in a folder of their own (`~/.lane-pilot/worktrees/lpattempt_…/feed-gen`); `git worktree remove` takes the
 * checkout and left that folder behind, empty (339 of 347 on OVH, 2026-10-23). Only an empty one directly under worktrees/ goes.
 */
async function removeEmptyWorktreeParent(top:string):Promise<void> {
  const parent=dirname(top);
  if(basename(dirname(parent))!=="worktrees"||basename(dirname(dirname(parent)))!==".lane-pilot") return;
  await rmdir(parent).catch(()=>undefined);
}

/** The worktree's own top folder: a subfolder workspace's path is not what `git worktree remove` takes. */
async function worktreeTop(worktreePath:string):Promise<string> {
  return (await git(worktreePath,["rev-parse","--show-toplevel"])).stdout.trim()||worktreePath;
}

/**
 * Removes Lane Pilot's own worktree and its lane/ branch; other worktrees are left alone. With `releaseDir` the work is
 * returned first (SMA rule 9: stop = the writer is gone AND its work is back): the uncommitted edits and the commits no
 * other branch has are saved by `snapshotWorktree`, and a snapshot that fails keeps the worktree.
 */
export async function removeLaneWorktree(input:{basePath:string;worktreePath:string;releaseDir?:string}):Promise<{removed:boolean;saved?:{status:"clean"|"saved"|"missing"|"failed";path:string|null;dirty:number;ahead:number;reason:string|null}}> {
  // A git command here would reach another worktree's index: the folder is retired, never snapshotted.
  const orphan=await orphanedWorktree(input.worktreePath);
  if(orphan) return {removed:await retireOrphanedWorktree(orphan)};
  const branch=(await git(input.worktreePath,["rev-parse","--abbrev-ref","HEAD"])).stdout.trim();
  if(!branch.startsWith("lane/")) return {removed:false};
  let saved:Awaited<ReturnType<typeof snapshotWorktree>>|undefined;
  if(input.releaseDir) {
    saved=await snapshotWorktree({worktreePath:input.worktreePath,name:branch.slice("lane/".length),dir:input.releaseDir});
    if(saved.status==="failed") return {removed:false,saved};
  }
  await recoverStaleGitLock(input.basePath);
  const top=await worktreeTop(input.worktreePath);
  const removed=(await git(input.basePath,["worktree","remove","--force",top])).ok;
  if(removed) { await git(input.basePath,["branch","-D",branch]); await removeEmptyWorktreeParent(top); }
  return {removed,...(saved?{saved}:{})};
}

/**
 * Before a finished attempt's worktree is released: its uncommitted edits and the commits no other branch has are
 * written to ~/.lane-pilot/released/<name>.patch, so a rejected attempt's work can still be read after the worktree is
 * gone. «failed» keeps the worktree (the caller does not release it).
 */
export async function snapshotWorktree(input:{worktreePath:string;name:string;dir:string}):Promise<{status:"clean"|"saved"|"missing"|"failed";path:string|null;dirty:number;ahead:number;reason:string|null}> {
  if(!(await stat(input.worktreePath).catch(()=>null))?.isDirectory()) return {status:"missing",path:null,dirty:0,ahead:0,reason:null};
  if(await orphanedWorktree(input.worktreePath)) return {status:"missing",path:null,dirty:0,ahead:0,reason:"orphaned worktree folder: its git admin dir belongs to another worktree"};
  const status=await git(input.worktreePath,["status","--porcelain","--untracked-files=all"]);
  if(!status.ok) return {status:"failed",path:null,dirty:0,ahead:0,reason:status.reason};
  const dirty=status.stdout.split("\n").filter(Boolean).length;
  const own=(await git(input.worktreePath,["rev-parse","--abbrev-ref","HEAD"])).stdout.trim();
  const others=(await git(input.worktreePath,["for-each-ref","--format=%(refname)","refs/heads"])).stdout.split("\n").filter((ref)=>ref&&ref!==`refs/heads/${own}`);
  const ahead=Number.parseInt((await git(input.worktreePath,["rev-list","--count","HEAD","--not",...others])).stdout.trim(),10)||0;
  if(!dirty&&!ahead) return {status:"clean",path:null,dirty,ahead,reason:null};
  // Written by git straight to files: a worktree with images made the in-memory patch overflow (ENOBUFS).
  await mkdir(input.dir,{recursive:true});
  const path=join(input.dir,`${input.name}.patch`);
  if(dirty){
    const add=await git(input.worktreePath,["add","-A"]);
    const diff=add.ok?await git(input.worktreePath,["diff","--cached","--binary","HEAD",`--output=${path}`]):add;
    if(!diff.ok) return {status:"failed",path:null,dirty,ahead,reason:diff.reason};
  }
  if(ahead){
    const patches=await git(input.worktreePath,["format-patch","-q",`-${ahead}`,"HEAD","-o",join(input.dir,`${input.name}-commits`)]);
    if(!patches.ok) return {status:"failed",path:null,dirty,ahead,reason:patches.reason};
  }
  return {status:"saved",path:dirty?path:join(input.dir,`${input.name}-commits`),dirty,ahead,reason:null};
}
