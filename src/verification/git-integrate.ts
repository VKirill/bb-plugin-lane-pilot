import { spawnSync } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type GitIntegration = {
  status:"merged"|"up-to-date"|"conflict"|"failed";
  commit:string|null;
  conflicts:string[];
  reason:string|null;
};

const FALLBACK_IDENTITY = ["-c", "user.name=Lane Pilot writer", "-c", "user.email=lane-pilot@localhost"];

function git(cwd:string,args:string[]) {
  const result=spawnSync("git",args,{cwd,encoding:"utf8",timeout:60_000,maxBuffer:4_000_000,windowsHide:true});
  if(result.error) return {ok:false as const,stdout:"",reason:result.error.message};
  if(result.status!==0) return {ok:false as const,stdout:result.stdout??"",reason:(result.stderr||result.stdout||`git exited ${result.status}`).trim()};
  return {ok:true as const,stdout:result.stdout,reason:""};
}

/** The repository's own identity when set, otherwise a writer identity, so commits never fail on a bare host. */
function identity(cwd:string):string[] {
  const email=git(cwd,["config","user.email"]);
  return email.ok&&email.stdout.trim()?[]:FALLBACK_IDENTITY;
}

/** One integration at a time per base checkout; a lock older than 10 minutes is stale. */
export async function withBaseLock<T>(basePath:string,work:()=>T|Promise<T>):Promise<T> {
  const lock=join(basePath,".git","lane-pilot-integrate.lock");
  const deadline=Date.now()+120_000;
  for(;;) {
    try { await mkdir(lock); break; }
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      const info=await stat(lock).catch(()=>null);
      if(info&&Date.now()-info.mtimeMs>600_000) { await rm(lock,{recursive:true,force:true}); continue; }
      if(Date.now()>deadline) throw new Error("another writer integration holds the base checkout");
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
  }
  // Awaited, so an async task keeps the lock until it finishes.
  try { return await work(); } finally { await rm(lock,{recursive:true,force:true}); }
}

/**
 * Commits the writer's worktree and merges it into the run's base checkout (main).
 * A conflict leaves main untouched and names the files, so the task can be redone on the new main.
 */
export async function integrateWorktree(input:{basePath:string;worktreePath:string;message:string;removeWorktree?:boolean}):Promise<GitIntegration> {
  const fail=(reason:string):GitIntegration=>({status:"failed",commit:null,conflicts:[],reason});
  const dirty=git(input.worktreePath,["status","--porcelain","--untracked-files=all"]);
  if(!dirty.ok) return fail(`worktree status: ${dirty.reason}`);
  if(dirty.stdout.trim()) {
    const add=git(input.worktreePath,["add","-A"]);
    if(!add.ok) return fail(`worktree add: ${add.reason}`);
    const commit=git(input.worktreePath,[...identity(input.worktreePath),"commit","-q","--no-verify","-m",input.message]);
    if(!commit.ok) return fail(`worktree commit: ${commit.reason}`);
  }
  const head=git(input.worktreePath,["rev-parse","HEAD"]);
  if(!head.ok) return fail(`worktree head: ${head.reason}`);
  const sha=head.stdout.trim();
  const branch=git(input.worktreePath,["rev-parse","--abbrev-ref","HEAD"]).stdout.trim();
  const result=await withBaseLock(input.basePath,()=>merge(input.basePath,sha,input.message));
  // Lane Pilot's own worktree is done once its work is in main, or once main moved past it (a conflict is redone fresh).
  if(input.removeWorktree&&result.status!=="failed") {
    git(input.basePath,["worktree","remove","--force",input.worktreePath]);
    if(branch.startsWith("lane/")) git(input.basePath,["branch","-D",branch]);
  }
  return result;
}

/** Creates Lane Pilot's own worktree of a section repository on a fresh lane/<name> branch from its HEAD. */
export async function createWorktree(input:{basePath:string;targetPath:string;name:string}):Promise<{status:"ready"|"failed";path:string|null;branch:string|null;reason:string|null}> {
  const top=git(input.basePath,["rev-parse","--show-toplevel"]);
  if(!top.ok) return {status:"failed",path:null,branch:null,reason:`not a git checkout: ${top.reason}`};
  const branch=`lane/${input.name}`;
  await mkdir(join(input.targetPath,".."),{recursive:true});
  const added=git(input.basePath,["worktree","add","-q","-b",branch,input.targetPath,"HEAD"]);
  if(!added.ok) return {status:"failed",path:null,branch:null,reason:added.reason};
  return {status:"ready",path:input.targetPath,branch,reason:null};
}

function merge(basePath:string,sha:string,message:string):GitIntegration {
  if(git(basePath,["merge-base","--is-ancestor",sha,"HEAD"]).ok) {
    return {status:"up-to-date",commit:git(basePath,["rev-parse","HEAD"]).stdout.trim()||null,conflicts:[],reason:null};
  }
  const merged=git(basePath,[...identity(basePath),"merge","--no-ff","--no-edit","-m",`Merge writer work: ${message}`,sha]);
  if(merged.ok) return {status:"merged",commit:git(basePath,["rev-parse","HEAD"]).stdout.trim()||null,conflicts:[],reason:null};
  const unmerged=git(basePath,["diff","--name-only","--diff-filter=U"]);
  const conflicts=unmerged.ok?unmerged.stdout.split("\n").map((line)=>line.trim()).filter(Boolean):[];
  git(basePath,["merge","--abort"]);
  return {status:"conflict",commit:null,conflicts,reason:merged.reason.split("\n").slice(-4).join("\n")};
}

/**
 * A git worktree has no ignored dependencies; link the base checkout's node_modules so the
 * writer's checks run, and keep the link out of git through the shared info/exclude.
 */
const installing=new Map<string,Promise<void>>();

/**
 * Installs a project's npm dependencies once, in the main checkout, from its lockfile. `npm ci` never
 * rewrites package-lock.json, so a writer no longer has to run `npm install` and trip the owns check,
 * and the offline verification sandbox finds the packages already in place.
 */
async function installBaseDependencies(basePath:string):Promise<void> {
  if((await stat(join(basePath,"node_modules")).catch(()=>null))?.isDirectory()) return;
  if(!(await stat(join(basePath,"package-lock.json")).catch(()=>null))?.isFile()) return;
  const running=installing.get(basePath)??Promise.resolve().then(()=>{
    spawnSync("npm",["ci","--no-audit","--no-fund"],{cwd:basePath,encoding:"utf8",timeout:540_000,maxBuffer:16<<20});
  }).finally(()=>installing.delete(basePath));
  installing.set(basePath,running);
  await running;
}

export async function prepareWorktree(input:{basePath:string;worktreePath:string}):Promise<{linked:string[]}> {
  await installBaseDependencies(input.basePath);
  const base=join(input.basePath,"node_modules"), target=join(input.worktreePath,"node_modules");
  if(!(await stat(base).catch(()=>null))?.isDirectory()||await lstat(target).catch(()=>null)) return {linked:[]};
  const common=git(input.worktreePath,["rev-parse","--git-common-dir"]);
  if(!common.ok) return {linked:[]};
  const dir=common.stdout.trim();
  const exclude=join(isAbsolute(dir)?dir:join(input.worktreePath,dir),"info","exclude");
  const current=await readFile(exclude,"utf8").catch(()=>"");
  if(!current.split("\n").includes("/node_modules")) {
    await mkdir(join(exclude,".."),{recursive:true});
    await appendFile(exclude,`${current&&!current.endsWith("\n")?"\n":""}/node_modules\n`);
  }
  await symlink(base,target,"dir");
  return {linked:["node_modules"]};
}

/** Removes Lane Pilot's own worktree and its lane/ branch; other worktrees are left alone. */
export async function removeLaneWorktree(input:{basePath:string;worktreePath:string}):Promise<{removed:boolean}> {
  const branch=git(input.worktreePath,["rev-parse","--abbrev-ref","HEAD"]).stdout.trim();
  if(!branch.startsWith("lane/")) return {removed:false};
  const removed=git(input.basePath,["worktree","remove","--force",input.worktreePath]).ok;
  if(removed) git(input.basePath,["branch","-D",branch]);
  return {removed};
}
