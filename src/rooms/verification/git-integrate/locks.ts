import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextOrNull, spawnAsync, statOrNull } from "@lane-pilot/kit";
import { BaseLockBusyError, git } from "./git-core";

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
  const info=await statOrNull(lock);
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
  const info=await statOrNull(join(dir.stdout.trim(),"MERGE_HEAD"));
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
      const info=await statOrNull(lock);
      const ownerText=await readTextOrNull(join(lock,"owner")) ?? "";
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
 * Puts back files a pass changed outside what it may write: a tracked file returns to HEAD, a file it created is removed.
 * Only paths that were clean before the pass reach here. A created file may be staged with other content (`git mv`), so its
 * index entry is dropped by force. Created files go first: on a case-insensitive disk `git mv DECISIONS.md decisions.md` leaves
 * one file, and removing decisions.md after DECISIONS.md came back from HEAD would delete it again.
 */
export async function revertPaths(input:{ projectCwd:string; paths:string[] }):Promise<{ reverted:string[]; failed:string[] }> {
  const reverted:string[] = [], failed:string[] = [];
  await withBaseLock(input.projectCwd, async () => {
    const created:string[] = [], tracked:string[] = [];
    for (const path of input.paths) {
      if (path.startsWith("/") || path.split("/").includes("..")) { failed.push(path); continue; }
      ((await git(input.projectCwd, ["cat-file", "-e", `HEAD:${path}`])).ok ? tracked : created).push(path);
    }
    for (const path of created) {
      try {
        const removed = await git(input.projectCwd, ["rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", path]);
        if (!removed.ok) throw new Error(removed.reason);
        await rm(join(input.projectCwd, path), { recursive:true, force:true });
        reverted.push(path);
      } catch { failed.push(path); }
    }
    for (const path of tracked) {
      const checked = await git(input.projectCwd, ["checkout", "HEAD", "--", path]);
      if (checked.ok) reverted.push(path); else failed.push(path);
    }
  });
  const order = (paths:string[]) => input.paths.filter((path) => paths.includes(path));
  return { reverted:order(reverted), failed:order(failed) };
}
/** git's words for a command that found <git-dir>/index.lock taken (withIndexLockNote adds the lock where git names none). */
export const INDEX_LOCKED=/index\.lock|unable to write (new )?index/i;

/** Waits until nobody holds <git-dir>/index.lock; false when it still stands at the deadline. */
export async function indexLockGone(cwd:string,waitMs:number):Promise<boolean> {
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
/**
 * One `npm ci` per checkout across processes: background jobs run in their own process, so the map above no longer
 * covers two worktree preparations of the same base. The loser waits for the winner and finds node_modules in place.
 */
export async function withInstallLock(basePath:string,work:()=>Promise<void>):Promise<void> {
  const lock=join(tmpdir(),`lane-pilot-npm-ci-${createHash("sha1").update(basePath).digest("hex").slice(0,16)}.lock`);
  const deadline=Date.now()+600_000;
  let held=false;
  while(!held) {
    try { await mkdir(lock); await writeFile(join(lock,"owner"),String(process.pid)); held=true; }
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      const owner=Number.parseInt(await readTextOrNull(join(lock,"owner")) ?? "",10);
      const info=await statOrNull(lock);
      if((Number.isInteger(owner)&&owner>0&&!ownerAlive(owner))||(info&&Date.now()-info.mtimeMs>900_000)) { await rm(lock,{recursive:true,force:true}); continue; }
      if(Date.now()>deadline) break;
      await new Promise((resolve)=>setTimeout(resolve,1_000));
    }
  }
  try { await work(); } finally { if(held) await rm(lock,{recursive:true,force:true}); }
}
