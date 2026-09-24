import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

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
    if(!top.ok||resolve(top.stdout.trim())!==resolve(root)) return null;
    return root;
  } catch { return null; }
}

function resolveCommit(cwd:string,ref:string) {
  if(!ref.trim()||ref.length>240||ref.includes("\0")) return {ok:false as const,reason:"git base ref is empty or exceeds the allowed length"};
  const result=git(cwd,["rev-parse","--verify","--end-of-options",`${ref}^{commit}`]);
  if(!result.ok) return {ok:false as const,reason:`git base ref could not be resolved: ${ref}`};
  const sha=result.stdout.trim();
  if(!/^[a-f0-9]{40,64}$/.test(sha)) return {ok:false as const,reason:"git returned an invalid commit id for base ref"};
  return {ok:true as const,sha};
}

function filterOwnershipNoise(paths:string[]):string[] {
  const prefixes=[".agents/",".repowise/",".worktrees/",".claude/worktrees/","node_modules/",".npm-cache/","npm-cache/",".npm/",".pnpm-store/","pnpm-store/",".yarn/cache/",".yarn/unplugged/",".cache/",".turbo/",".next/cache/","coverage/",".git/"];
  const files=new Set(["PROGRESS.md","LESSONS.md","AGENTS.md","CLAUDE.md"]);
  return [...new Set(paths.map((path)=>path.replace(/^\.\//, "")).filter((path)=>{
    if(prefixes.some((prefix)=>path.startsWith(prefix))||files.has(path)) return false;
    const parts=path.split("/");
    return !parts.includes("__pycache__")&&!parts.includes(".pytest_cache")&&!parts.includes(".mypy_cache")&&!parts.includes(".ruff_cache")&&!path.endsWith(".pyc")&&!path.endsWith(".pyo");
  }))].sort();
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

export async function gitOwnershipChangedPaths(input:{projectCwd:string;baseSha:string|null;compareCommitted:boolean}):Promise<{status:"ready"|"not-git"|"failed";headSha:string|null;paths:string[];reason:string|null}> {
  const cwd=await checkedRoot(input.projectCwd);
  if(!cwd) return {status:"not-git",headSha:null,paths:[],reason:"ownership base requires a real git worktree root"};
  const head=git(cwd,["rev-parse","--verify","HEAD^{commit}"]);
  if(!head.ok) return {status:"failed",headSha:null,paths:[],reason:"could not read current git HEAD"};
  const headSha=head.stdout.trim();
  if(!/^[a-f0-9]{40,64}$/.test(headSha)) return {status:"failed",headSha:null,paths:[],reason:"git returned an invalid HEAD commit id"};
  if(!input.compareCommitted) return {status:"ready",headSha,paths:[],reason:null};
  if(!input.baseSha||!/^[a-f0-9]{40,64}$/.test(input.baseSha)) return {status:"failed",headSha,paths:[],reason:"frozen git base commit is missing or invalid"};
  const mergeBase=git(cwd,["merge-base",input.baseSha,headSha]);
  if(!mergeBase.ok) return {status:"failed",headSha,paths:[],reason:"git base and current HEAD have no merge base"};
  const diff=git(cwd,["diff","--name-only","-z","--no-renames",`${mergeBase.stdout.trim()}...${headSha}`]);
  if(!diff.ok) return {status:"failed",headSha,paths:[],reason:"could not compute committed ownership diff"};
  return {status:"ready",headSha,paths:filterOwnershipNoise(diff.stdout.split("\0").filter(Boolean)),reason:null};
}
