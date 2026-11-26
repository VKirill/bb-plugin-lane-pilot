import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { isFsAbsent, orMiss, spawnAsync, statOrNull } from "@lane-pilot/kit";
import { git } from "./git-core";
import { recoverStaleGitLock } from "./locks";
import { orphanedWorktree, removeEmptyWorktreeParent, retireCollidingWorktrees, retireOrphanedWorktree, worktreeTop } from "./worktree-hygiene";
import { linkWorktreeDependencies } from "./worktree-dependencies";
import { applyOwnsBarrier } from "./owns-barrier";

/**
 * The worktree standard (docs/worktrees.md, SMA 4г): one place per machine, outside every repository, with names a person can read.
 * `<home>/.lane-pilot/worktrees/<repository>/<id>`: the repository's folder name, then the attempt or pass id (`lpattempt_…`,
 * `self-repair-…`, `docs-…`, `regress-…`, `gate-<sha8>-…`). Until 0.1.561 the order was `<id>/<repository>`; both are two levels deep,
 * so every sweep reads either, and an attempt that started before the deploy finishes and is removed where it stands.
 */
export const laneWorktreeRoot = (home?: string): string =>
  home ? join(home, ".lane-pilot", "worktrees") : process.env.LANE_PILOT_WORKTREE_ROOT?.trim() || join(homedir(), ".lane-pilot", "worktrees");

/** The repository's folder under the root: its own name, with nothing in it that would make a path (separators, a leading dot). */
export function repoFolderName(repoTop: string): string {
  const name = basename(repoTop.replace(/[\\/]+$/u, "")) || "repo";
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\\/:]/gu, "_").replace(/^\.+/u, "_");
}

/** Where a new worktree of `repoTop` for `id` is made. */
export const laneWorktreeTarget = (root: string, repoTop: string, id: string): string => join(root, repoFolderName(repoTop), id);

/** How a ref's work is already in a target branch: its commits are there, the same patches are there (rebase, cherry-pick), or the whole branch is there as one commit (squash). */
export type MergedHow = "ancestor" | "patch-equivalent" | "squash";

/** The branches a repository's work lands on: main (else master) and the branch its own checkout has out, without repeats. */
export async function mergeTargets(repo: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of ["main", "master"]) {
    if ((await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${name}`])).ok) { out.push(name); break; }
  }
  // The repository's own checkout (a worktree's `commondir` parent): the branch writers merge into when it is not main.
  const common = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const own = common ? (await git(repo, [`--git-dir=${common}`, "symbolic-ref", "-q", "--short", "HEAD"])).stdout.trim() : "";
  if (own && !out.includes(own)) out.push(own);
  return out;
}

/**
 * Whether the work of `ref` is already in `target`. Ancestry first; then `git cherry` (every commit has a patch-equivalent one in the
 * target: a rebase or a cherry-pick merge); then the squash probe — the patch id of the branch's whole change since its merge base,
 * compared with the patch ids of every commit the target got since then (read-only). Null: some of its work is nowhere in the target.
 */
export async function mergedInto(repo: string, ref: string, target: string): Promise<MergedHow | null> {
  if ((await git(repo, ["merge-base", "--is-ancestor", ref, target])).ok) return "ancestor";
  const cherry = await git(repo, ["cherry", target, ref]);
  if (cherry.ok) {
    const lines = cherry.stdout.split("\n").filter(Boolean);
    if (lines.length && lines.every((line) => line.startsWith("-"))) return "patch-equivalent";
  }
  const base = (await git(repo, ["merge-base", target, ref])).stdout.trim();
  const tip = (await git(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(base) || !/^[0-9a-f]{40,64}$/u.test(tip)) return null;
  // Read-only: nothing is written into the repository (a dry run on someone's checkout leaves no object behind).
  const ids = async (script: string) => {
    const ran = await spawnAsync("sh", ["-c", script, "sh", base, tip, target], { cwd: repo, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    return ran.status === 0 ? ran.stdout.split("\n").map((line) => line.split(" ")[0]!).filter(Boolean) : [];
  };
  const [whole] = await ids(`git diff "$1" "$2" | git patch-id --stable`);
  if (!whole) return null;
  const landed = await ids(`git log -p --no-merges --format='commit %H' "$1..$3" | git patch-id --stable`);
  return landed.includes(whole) ? "squash" : null;
}

/** The first target `ref` is merged into, with how; null when none holds all of its work. */
export async function mergedAnywhere(repo: string, ref: string, targets?: readonly string[]): Promise<{ target: string; how: MergedHow } | null> {
  for (const target of targets ?? await mergeTargets(repo)) {
    const how = await mergedInto(repo, ref, target);
    if (how) return { target, how };
  }
  return null;
}

/** How many commits of `ref` no target has by ancestry (patch-equivalent ones included: this is the count a person reads). */
export async function aheadOf(repo: string, ref: string, targets: readonly string[]): Promise<number> {
  if (!targets.length) return 0;
  const counted = await git(repo, ["rev-list", "--count", ref, "--not", ...targets]);
  return counted.ok ? Number.parseInt(counted.stdout.trim(), 10) || 0 : 0;
}

/** The worktree folders that have `branch` checked out (`git worktree list --porcelain`). */
async function checkedOutAt(repo: string, branch: string): Promise<string[]> {
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return ["?"];
  return listed.stdout.split(/\n\n+/u).filter((block) => block.split("\n").includes(`branch refs/heads/${branch}`))
    .map((block) => block.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? "?");
}

/**
 * A branch goes only when its work is merged (by ancestry, patch or squash) into a target, and nothing has it checked out. A branch with
 * commits merged nowhere is never deleted: it is kept and named, with the count of its commits (the owner's rule, SMA 4г).
 */
export async function deleteBranchIfMerged(repo: string, branch: string, targets?: readonly string[]): Promise<{ deleted: boolean; how: MergedHow | null; reason: string | null; ahead: number }> {
  if (!(await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).ok) return { deleted: false, how: null, reason: null, ahead: 0 };
  const list = targets ?? await mergeTargets(repo);
  if (list.includes(branch)) return { deleted: false, how: null, reason: "it is a target branch", ahead: 0 };
  const holders = await checkedOutAt(repo, branch);
  if (holders.length) return { deleted: false, how: null, reason: `checked out at ${holders.join(", ")}`, ahead: 0 };
  const merged = await mergedAnywhere(repo, branch, list);
  if (!merged) {
    const ahead = await aheadOf(repo, branch, list);
    return { deleted: false, how: null, reason: list.length ? `${ahead} commit(s) merged into none of ${list.join(", ")}` : "the repository has no main branch to compare with", ahead };
  }
  const removed = await git(repo, ["branch", "-D", branch]);
  if (removed.ok) await git(repo, ["config", "--local", "--unset", `branch.${branch}.laneTask`]);
  return { deleted: removed.ok, how: merged.how, reason: removed.ok ? null : removed.reason, ahead: 0 };
}

/** Where a Lane chat folder sits in its git checkout: at the repo root, or nested inside a larger repo. */
export async function workspaceGitLayout(workspacePath:string):Promise<
  {ok:true;repoTop:string;nested:boolean;prefix:string} | {ok:false;reason:string}
> {
  const top=await git(workspacePath,["rev-parse","--show-toplevel"]);
  if(!top.ok||!top.stdout.trim()) return {ok:false,reason:top.reason||"not a git checkout"};
  const repoTop=top.stdout.trim();
  const [workspaceReal,topReal]=await Promise.all([
    orMiss(realpath(workspacePath),workspacePath,isFsAbsent),
    orMiss(realpath(repoTop),repoTop,isFsAbsent),
  ]);
  const prefix=relative(topReal,workspaceReal).replace(/\\/g,"/");
  if(prefix.startsWith("..")) return {ok:false,reason:"workspace is outside its git checkout"};
  const nested=prefix!==""&&prefix!==".";
  return {ok:true,repoTop,nested,prefix:nested?prefix:""};
}

/**
 * The folder a new worktree of the checkout at `basePath` gets: `<root>/<repository>/<name>` (docs/worktrees.md). The repository is
 * the git top the worktree forks, so a chat folder nested in a larger repository is filed under that repository's name.
 */
export async function laneWorktreeTargetFor(root:string, basePath:string, name:string):Promise<string> {
  const layout=await workspaceGitLayout(basePath);
  return laneWorktreeTarget(root,layout.ok?layout.repoTop:basePath,name);
}

/** The folder of the worktree that has `branch` checked out, from `git worktree list --porcelain`; null when none has. */
export function worktreeOfBranch(porcelain:string, branch:string):string|null {
  for(const block of porcelain.split(/\n\n+/)) {
    const lines=block.split("\n");
    if(lines.includes(`branch refs/heads/${branch}`)) return lines.find((line)=>line.startsWith("worktree "))?.slice("worktree ".length)??null;
  }
  return null;
}

/** The task recorded on `lane/<name>` when it was created; empty when this branch predates the mark. */
async function laneBranchTask(repoRoot:string, branch:string):Promise<string> {
  const read=await git(repoRoot,["config","--local","--get",`branch.${branch}.laneTask`]);
  return read.ok?read.stdout.trim():"";
}

/**
 * Reuse the branch when it still has commits main does not, and it is this task's (or unmarked). A branch main has
 * moved past, or one marked for another task, is dropped so the retry does not inherit it.
 */
async function reuseLaneBranch(repoRoot:string, branch:string, taskId?:string):Promise<boolean> {
  const stored=await laneBranchTask(repoRoot,branch);
  if(taskId&&stored&&stored!==taskId) return false;
  const tip=(await git(repoRoot,["rev-parse",branch])).stdout.trim();
  const head=(await git(repoRoot,["rev-parse","HEAD"])).stdout.trim();
  const contained=(await git(repoRoot,["merge-base","--is-ancestor",branch,"HEAD"])).ok;
  return !contained||tip===head;
}

/** Removes the worktree that holds the branch, then the branch, so `worktree add -b` can create it again. */
async function dropLaneBranch(repoRoot:string, branch:string):Promise<void> {
  const holder=worktreeOfBranch((await git(repoRoot,["worktree","list","--porcelain"])).stdout,branch);
  if(holder) await git(repoRoot,["worktree","remove","--force",holder]);
  await git(repoRoot,["worktree","prune"]);
  await git(repoRoot,["branch","-D",branch]);
  await git(repoRoot,["config","--local","--unset",`branch.${branch}.laneTask`]);
}

/**
 * Creates Lane Pilot's own worktree of a section repository on a fresh lane/<name> branch from its HEAD. A chat folder
 * nested in a larger repo gets a worktree of that repo; `path` is then the same subfolder inside it, where the writer works.
 */
export async function createWorktree(input:{basePath:string;targetPath:string;name:string;
  /** Start from this commit instead of the base checkout's HEAD (a reverify checks out the merged change, a revert compares with its base). */
  commit?:string;
  /** The task this branch belongs to. A retry reuses the branch only while it is unmerged and still that task's. */
  taskId?:string;}):Promise<{status:"ready"|"failed";path:string|null;branch:string|null;reason:string|null;
  /** The commit the worktree starts from: the attempt's base, recorded so a rollback can name it. */
  baseSha:string|null}> {
  const layout=await workspaceGitLayout(input.basePath);
  if(!layout.ok) return {status:"failed",path:null,branch:null,baseSha:null,reason:`not a git checkout: ${layout.reason}`};
  const repoRoot=layout.nested?layout.repoTop:input.basePath;
  const branch=`lane/${input.name}`;
  await mkdir(join(input.targetPath,".."),{recursive:true});
  await recoverStaleGitLock(repoRoot);
  // The branch of this attempt already exists: an earlier create made it and its answer was lost (a plugin reload, a host call that
  // timed out on a machine deep in swap). Taking it again is safe, the name is the attempt's own; `-b` failed with «a branch named
  // lane/<attempt> already exists» and parked the task (2026-10-28, Vampirism Fire: two tasks blocked with their worktrees on disk).
  let root=input.targetPath;
  const branchExists=(await git(repoRoot,["rev-parse","--verify","-q",`refs/heads/${branch}`])).ok;
  const reuse=branchExists && await reuseLaneBranch(repoRoot,branch,input.taskId);
  if(reuse) {
    const holder=worktreeOfBranch((await git(repoRoot,["worktree","list","--porcelain"])).stdout,branch);
    if(holder&&existsSync(holder)) root=holder;
    else {
      await git(repoRoot,["worktree","prune"]);
      const attached=await git(repoRoot,["worktree","add","-q",input.targetPath,branch]);
      if(!attached.ok) return {status:"failed",path:null,branch:null,baseSha:null,reason:attached.reason};
      await retireCollidingWorktrees(input.targetPath);
    }
  } else {
    if(branchExists) await dropLaneBranch(repoRoot,branch);
    let added=await git(repoRoot,["worktree","add","-q","-b",branch,input.targetPath,input.commit??"HEAD"]);
    if(!added.ok && /already exists/.test(added.reason)) {
      if(await reuseLaneBranch(repoRoot,branch,input.taskId)) {
        added=await git(repoRoot,["worktree","add","-q",input.targetPath,branch]);
      } else {
        await dropLaneBranch(repoRoot,branch);
        added=await git(repoRoot,["worktree","add","-q","-b",branch,input.targetPath,input.commit??"HEAD"]);
      }
    }
    if(!added.ok) return {status:"failed",path:null,branch:null,baseSha:null,reason:added.reason};
    // git may have given this worktree the admin name a half-removed old folder still points at.
    await retireCollidingWorktrees(input.targetPath);
  }
  if(input.taskId) await git(repoRoot,["config","--local",`branch.${branch}.laneTask`,input.taskId]);
  const head=await git(root,["rev-parse","HEAD"]);
  const path=layout.nested?join(root,layout.prefix):root;
  // A subfolder with no tracked file yet is not in the checkout.
  if(layout.nested) await mkdir(path,{recursive:true});
  return {status:"ready",path,branch,reason:null,baseSha:head.ok&&/^[a-f0-9]{40,64}$/.test(head.stdout.trim())?head.stdout.trim():null};
}
export async function prepareWorktree(input:{basePath:string;worktreePath:string;
  /** F-01: with the contract, make tracked files outside owns_paths read-only for the attempt. */
  ownsBarrier?:boolean;ownsPaths?:string[];neverTouch?:string[];readOnlyPaths?:readonly string[]}):Promise<{linked:string[];locked?:number}> {
  const base=await workspaceGitLayout(input.basePath);
  let dependencies:Parameters<typeof linkWorktreeDependencies>[0]=input;
  if(base.ok&&base.nested) {
    const target=await workspaceGitLayout(input.worktreePath);
    if(!target.ok||(target.prefix!==base.prefix&&(target.nested||input.ownsBarrier))) throw new Error("worktree_workspace_mismatch: section paths differ between checkouts");
    // Gates use root scratch checkouts; writers retain their section cwd and ownership barrier.
    dependencies={...input,basePath:base.repoTop,worktreePath:target.repoTop,selectedSubdir:base.prefix};
  }
  const out=await linkWorktreeDependencies(dependencies);
  const locked=input.ownsBarrier&&(input.ownsPaths?.length||input.readOnlyPaths?.length)
    ?(await applyOwnsBarrier({worktreePath:input.worktreePath,ownsPaths:input.ownsPaths??[],neverTouch:input.neverTouch??[],...(input.readOnlyPaths?{readOnlyPaths:input.readOnlyPaths}:{})})).locked
    :undefined;
  return locked===undefined?out:{...out,locked};
}
/**
 * Removes Lane Pilot's own worktree and, when its work is merged, its branch; other worktrees are left alone. With `releaseDir` the
 * work is returned first (SMA rule 9: stop = the writer is gone AND its work is back): the uncommitted edits and the commits no
 * other branch has are saved by `snapshotWorktree`, and a snapshot that fails keeps the worktree.
 * The branch goes only when its work is in main (ancestry, patch or squash, `deleteBranchIfMerged`): a cancelled task with commits
 * merged nowhere keeps `lane/<attempt>` (until 0.1.561 it was `branch -D`, saved only as a patch), and `branchKept` names it.
 */
export async function removeLaneWorktree(input:{basePath:string;worktreePath:string;releaseDir?:string}):Promise<{removed:boolean;saved?:{status:"clean"|"saved"|"missing"|"failed";path:string|null;dirty:number;ahead:number;reason:string|null};
  /** The branch that stayed because some of its commits are merged nowhere. */
  branchKept?:{branch:string;ahead:number;reason:string}}> {
  // A git command here would reach another worktree's index: the folder is retired, never snapshotted.
  const orphan=await orphanedWorktree(input.worktreePath);
  if(orphan) return {removed:await retireOrphanedWorktree(orphan)};
  const branch=(await git(input.worktreePath,["rev-parse","--abbrev-ref","HEAD"])).stdout.trim();
  // A phase's own tree (phase/candidate.ts: branch phase/<id> at <base>/.git/lp-phases/<id>) is Lane Pilot's too. Both marks are asked for:
  // a person's branch named phase/x somewhere else stays. Until 0.1.531 only lane/ passed, so no phase ever gave its tree back (11 left in the drill sandbox, 2026-11-11).
  const phase=branch.startsWith("phase/")&&/\/\.git\/lp-phases\/[^/]+\/*$/.test(input.worktreePath);
  if(!branch.startsWith("lane/")&&!phase) return {removed:false};
  let saved:Awaited<ReturnType<typeof snapshotWorktree>>|undefined;
  if(input.releaseDir) {
    saved=await snapshotWorktree({worktreePath:input.worktreePath,name:phase?branch.replace("/","-"):branch.slice("lane/".length),dir:input.releaseDir});
    if(saved.status==="failed") return {removed:false,saved};
  }
  await recoverStaleGitLock(input.basePath);
  const top=await worktreeTop(input.worktreePath);
  const removed=(await git(input.basePath,["worktree","remove","--force",top])).ok;
  // The branch phase/<id> stays as the record of the package; a lane/ branch goes with its tree once its work is in main.
  let branchKept:{branch:string;ahead:number;reason:string}|undefined;
  if(removed) {
    if(!phase) {
      const dropped=await deleteBranchIfMerged(input.basePath,branch);
      if(!dropped.deleted&&dropped.reason) {
        branchKept={branch,ahead:dropped.ahead,reason:dropped.reason};
        console.warn(`lane-pilot: kept branch ${branch} after removing its worktree ${top}: ${dropped.reason}`);
      }
    }
    await removeEmptyWorktreeParent(top);
  }
  return {removed,...(saved?{saved}:{}),...(branchKept?{branchKept}:{})};
}

/**
 * Before a finished attempt's worktree is released: its uncommitted edits and the commits no other branch has are
 * written to ~/.lane-pilot/released/<name>.patch, so a rejected attempt's work can still be read after the worktree is
 * gone. «failed» keeps the worktree (the caller does not release it).
 */
export async function snapshotWorktree(input:{worktreePath:string;name:string;dir:string}):Promise<{status:"clean"|"saved"|"missing"|"failed";path:string|null;dirty:number;ahead:number;reason:string|null}> {
  if(!(await statOrNull(input.worktreePath))?.isDirectory()) return {status:"missing",path:null,dirty:0,ahead:0,reason:null};
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
