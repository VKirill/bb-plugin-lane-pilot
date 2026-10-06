import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

export type GitOwnershipBase = {
  status:"ready"|"not-git"|"invalid-ref"|"failed";
  branch:string|null;
  headSha:string|null;
  baseRef:string|null;
  baseSha:string|null;
  compareCommitted:boolean;
  reason:string|null;
};

function git(cwd:string,args:string[]) {
  const result=spawnSync("git",args,{cwd,encoding:"utf8",timeout:10_000,maxBuffer:2_000_000,windowsHide:true});
  if(result.error) return {ok:false as const,reason:result.error.message};
  if(result.status!==0) return {ok:false as const,reason:(result.stderr||`git exited ${result.status}`).trim()};
  return {ok:true as const,stdout:result.stdout};
}

async function checkedRoot(projectCwd:string):Promise<string|null> {
  try {
    const info=await lstat(projectCwd);
    if(!info.isDirectory()||info.isSymbolicLink()) return null;
    const root=await realpath(projectCwd);
    const top=git(root,["rev-parse","--show-toplevel"]);
    if(!top.ok) return null;
    const prefix=relative(resolve(top.stdout.trim()),resolve(root)).replace(/\\/g,"/");
    if(prefix.startsWith("..")) return null;
    return root;
  } catch { return null; }
}

function cwdRelativePaths(stdout:string):string[] {
  return stdout.split("\0").map((path)=>path.replace(/^\.\//,"")).filter((path)=>path && !path.startsWith("../") && !path.split("/").includes(".."));
}

function workingTreeRelative(cwd:string):string[] {
  const diff=git(cwd,["diff","--name-only","-z","--relative","HEAD"]);
  const others=git(cwd,["ls-files","-o","--exclude-standard","-z"]);
  return [...new Set([
    ...(diff.ok?cwdRelativePaths(diff.stdout):[]),
    ...(others.ok?cwdRelativePaths(others.stdout):[]),
  ])];
}

function isNestedCheckout(cwd:string):boolean {
  const top=git(cwd,["rev-parse","--show-toplevel"]);
  return Boolean(top.ok && resolve(top.stdout.trim()) !== resolve(cwd));
}

/** Keep dirt that lives under a nested chat folder, with paths relative to that folder. */
export function dirtInsideWorkspace<T extends {path:string}>(snapshots:T[], prefix:string):T[] {
  if (!prefix) return snapshots;
  const slash = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return snapshots.flatMap((row) => {
    const path = row.path.replace(/^\.\//, "");
    if (!path.startsWith(slash)) return [];
    const relativePath = path.slice(slash.length);
    return relativePath ? [{ ...row, path: relativePath }] : [];
  });
}

function resolveCommit(cwd:string,ref:string) {
  if(!ref.trim()||ref.length>240||ref.includes("\0")) return {ok:false as const,reason:"git base ref is empty or exceeds the allowed length"};
  const result=git(cwd,["rev-parse","--verify","--end-of-options",`${ref}^{commit}`]);
  if(!result.ok) return {ok:false as const,reason:`git base ref could not be resolved: ${ref}`};
  const sha=result.stdout.trim();
  if(!/^[a-f0-9]{40,64}$/.test(sha)) return {ok:false as const,reason:"git returned an invalid commit id for base ref"};
  return {ok:true as const,sha};
}

/** Cache folders tools write at any depth while checks run. */
export const TOOL_CACHE_DIRS=new Set(["node_modules",".vite",".vitest",".turbo",".cache",".parcel-cache",".eslintcache",".pytest_cache",".mypy_cache",".ruff_cache","__pycache__"]);

/** Bookkeeping the harness, hooks and sibling agents write into a workspace; never a writer's change. */
export function filterOwnershipNoise(paths:string[]):string[] {
  const prefixes=[".agents/",".bb/",".repowise/",".worktrees/",".claude/worktrees/","node_modules/",".npm-cache/","npm-cache/",".npm/",".pnpm-store/","pnpm-store/",".yarn/cache/",".yarn/unplugged/",".cache/",".turbo/",".next/cache/","coverage/",".git/"];
  const files=new Set(["PROGRESS.md","LESSONS.md","AGENTS.md","CLAUDE.md"]);
  return [...new Set(paths.map((path)=>path.replace(/^\.\//, "")).filter((path)=>{
    if(prefixes.some((prefix)=>path.startsWith(prefix))||files.has(path)) return false;
    const parts=path.split("/");
    // Tool caches inside a package of a monorepo (packages/contracts/.vite/vitest/…) are written by the checks
    // themselves, not by the writer (SelfyStudio, 2026-10-02).
    if(parts.slice(0,-1).some((part)=>TOOL_CACHE_DIRS.has(part))) return false;
    return !parts.includes("__pycache__")&&!parts.includes(".pytest_cache")&&!parts.includes(".mypy_cache")&&!parts.includes(".ruff_cache")&&!path.endsWith(".pyc")&&!path.endsWith(".pyo");
  }))].sort();
}

/**
 * One normalisation before every ownership decision: dirt outside the workspace dropped, the rest made
 * workspace-relative (dirtInsideWorkspace), then bookkeeping and tool caches filtered (filterOwnershipNoise).
 * A snapshot may arrive repo-relative with paths of other agents (a workspace nested in a larger repo,
 * OVH 2026-10-06); no check below may ever see those.
 */
export function workspaceRelativeDirt<T extends {path:string}>(snapshots:T[], prefix:string):T[] {
  const inside=dirtInsideWorkspace(snapshots, prefix);
  const clean=new Set(filterOwnershipNoise(inside.map((row)=>row.path)));
  return inside.filter((row)=>clean.has(row.path));
}

export async function resolveGitOwnershipBase(input:{projectCwd:string;baseRef?:string}):Promise<GitOwnershipBase> {
  const cwd=await checkedRoot(input.projectCwd);
  if(!cwd) return {status:"not-git",branch:null,headSha:null,baseRef:null,baseSha:null,compareCommitted:false,reason:"ownership base requires a real git worktree root"};
  const branchResult=git(cwd,["rev-parse","--abbrev-ref","HEAD"]);
  const headResult=git(cwd,["rev-parse","--verify","HEAD^{commit}"]);
  if(!branchResult.ok||!headResult.ok) return {status:"failed",branch:null,headSha:null,baseRef:null,baseSha:null,compareCommitted:false,reason:"could not read current git branch and HEAD"};
  const branch=branchResult.stdout.trim();
  const headSha=headResult.stdout.trim();
  if(!/^[a-f0-9]{40,64}$/.test(headSha)) return {status:"failed",branch,headSha:null,baseRef:null,baseSha:null,compareCommitted:false,reason:"git returned an invalid HEAD commit id"};
  if(input.baseRef!==undefined) {
    const resolved=resolveCommit(cwd,input.baseRef);
    return resolved.ok
      ? {status:"ready",branch,headSha,baseRef:input.baseRef,baseSha:resolved.sha,compareCommitted:true,reason:null}
      : {status:"invalid-ref",branch,headSha,baseRef:input.baseRef,baseSha:null,compareCommitted:false,reason:resolved.reason};
  }
  if(branch==="main"||branch==="master") return {status:"ready",branch,headSha,baseRef:null,baseSha:null,compareCommitted:false,reason:null};
  for(const ref of ["main","master"]) {
    const resolved=resolveCommit(cwd,ref);
    if(resolved.ok) return {status:"ready",branch,headSha,baseRef:ref,baseSha:resolved.sha,compareCommitted:true,reason:null};
  }
  return {status:"ready",branch,headSha,baseRef:"HEAD",baseSha:headSha,compareCommitted:true,reason:null};
}

/** `unfiltered` keeps .agents/ and memory files: the project-life stage must see exactly those. */
export async function gitOwnershipChangedPaths(input:{projectCwd:string;baseSha:string|null;compareCommitted:boolean;unfiltered?:boolean}):Promise<{status:"ready"|"not-git"|"failed";headSha:string|null;paths:string[];reason:string|null}> {
  const cwd=await checkedRoot(input.projectCwd);
  if(!cwd) return {status:"not-git",headSha:null,paths:[],reason:"ownership base requires a real git worktree root"};
  const head=git(cwd,["rev-parse","--verify","HEAD^{commit}"]);
  if(!head.ok) return {status:"failed",headSha:null,paths:[],reason:"could not read current git HEAD"};
  const headSha=head.stdout.trim();
  if(!/^[a-f0-9]{40,64}$/.test(headSha)) return {status:"failed",headSha:null,paths:[],reason:"git returned an invalid HEAD commit id"};
  if(!input.compareCommitted) {
    const paths=isNestedCheckout(cwd)?workingTreeRelative(cwd):[];
    return {status:"ready",headSha,paths:input.unfiltered?[...new Set(paths)].sort():filterOwnershipNoise(paths),reason:null};
  }
  if(!input.baseSha||!/^[a-f0-9]{40,64}$/.test(input.baseSha)) return {status:"failed",headSha,paths:[],reason:"frozen git base commit is missing or invalid"};
  const mergeBase=git(cwd,["merge-base",input.baseSha,headSha]);
  if(!mergeBase.ok) return {status:"failed",headSha,paths:[],reason:"git base and current HEAD have no merge base"};
  const diff=git(cwd,["diff","--name-only","-z","--no-renames","--relative",`${mergeBase.stdout.trim()}...${headSha}`]);
  if(!diff.ok) return {status:"failed",headSha,paths:[],reason:"could not compute committed ownership diff"};
  const paths=cwdRelativePaths(diff.stdout);
  return {status:"ready",headSha,paths:input.unfiltered?[...new Set(paths)].sort():filterOwnershipNoise(paths),reason:null};
}
