import { readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { bestEffort, isFsAbsent, lstatOrNull, orMiss, readTextOrNull } from "@lane-pilot/kit";
import { git } from "./git-core";

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
    const entry=await lstatOrNull(join(top,".git"));
    if(entry) { if(!entry.isFile()) return null; break; }
    const up=dirname(top);
    if(up===top) return null;
    top=up;
  }
  const adminDir=(await readTextOrNull(join(top,".git")) ?? "").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if(!adminDir) return null;
  const back=(await readTextOrNull(join(adminDir,"gitdir")) ?? "").trim();
  const [mine,theirs]=await Promise.all([orMiss(realpath(join(top,".git")),join(top,".git"),isFsAbsent),back?orMiss(realpath(back),back,isFsAbsent):Promise.resolve("")]);
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
export async function retireOrphanedWorktree(orphan:{top:string;adminDir:string}):Promise<boolean> {
  await bestEffort(console.warn, `orphaned worktree rename ${orphan.top}`, rename(join(orphan.top,".git"),join(orphan.top,".git.orphaned")), undefined);
  if(!laneWorktreeRootOf(orphan.top)) return false;
  console.warn(`lane-pilot: removed the orphaned worktree folder ${orphan.top} (its .git named ${orphan.adminDir}, which git gave to another worktree)`);
  await bestEffort(console.warn, `orphaned worktree remove ${orphan.top}`, rm(orphan.top,{recursive:true,force:true}), undefined);
  await removeEmptyWorktreeParent(orphan.top);
  return true;
}

/** Other folders under Lane Pilot's worktree root whose `.git` names the admin dir a new worktree just got are retired. */
export async function retireCollidingWorktrees(targetPath:string):Promise<void> {
  const root=laneWorktreeRootOf(targetPath);
  if(!root) return;
  const own=await orMiss(realpath(targetPath),targetPath,isFsAbsent);
  for(const attempt of await orMiss(readdir(root),[] as string[],isFsAbsent)) {
    try {
      for(const name of await orMiss(readdir(join(root,attempt)),[] as string[],isFsAbsent)) {
        const folder=join(root,attempt,name);
        if((await orMiss(realpath(folder),folder,isFsAbsent))===own) continue;
        const orphan=await orphanedWorktree(folder);
        if(orphan&&orphan.top===folder) await retireOrphanedWorktree(orphan);
      }
    } catch (cause) {
      console.warn(`lane-pilot: skipped colliding worktrees under ${join(root,attempt)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}
/**
 * Lane Pilot's worktrees sit in a folder of their own (`~/.lane-pilot/worktrees/lpattempt_…/feed-gen`); `git worktree remove` takes the
 * checkout and left that folder behind, empty (339 of 347 on OVH, 2026-10-23). Only an empty one directly under worktrees/ goes.
 */
export async function removeEmptyWorktreeParent(top:string):Promise<void> {
  const parent=dirname(top);
  if(basename(dirname(parent))!=="worktrees"||basename(dirname(dirname(parent)))!==".lane-pilot") return;
  await bestEffort(console.warn, `worktree parent rmdir ${parent}`, rmdir(parent), undefined);
}

/** The worktree's own top folder: a subfolder workspace's path is not what `git worktree remove` takes. */
export async function worktreeTop(worktreePath:string):Promise<string> {
  return (await git(worktreePath,["rev-parse","--show-toplevel"])).stdout.trim()||worktreePath;
}
