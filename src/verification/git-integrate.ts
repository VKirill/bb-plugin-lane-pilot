import { spawnSync } from "node:child_process";
import { appendFile, cp, lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

export type GitIntegration = {
  status:"merged"|"up-to-date"|"conflict"|"failed"|"busy";
  commit:string|null;
  conflicts:string[];
  reason:string|null;
  /** With «busy»: what the integration holding the base checkout merges (its commit message). */
  holder?:string|null;
};

/** The base checkout is held by a live integration; the caller waits and tries again instead of failing. */
export class BaseLockBusyError extends Error {
  constructor(readonly holder:string|null) {
    super(`another writer integration holds the base checkout${holder?`: ${holder}`:""}`);
    this.name="BaseLockBusyError";
  }
}

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

/** True while the process that took a lock still runs; a host process killed mid-merge leaves its lock behind. */
function ownerAlive(pid:number):boolean {
  try { process.kill(pid,0); return true; }
  catch(error) { return (error as NodeJS.ErrnoException).code==="EPERM"; }
}

/**
 * One integration at a time per base checkout. The lock names its process; a lock whose process is gone
 * (the host restarted mid-merge) is taken over at once, and any lock older than 10 minutes is stale.
 */
export async function withBaseLock<T>(basePath:string,work:()=>T|Promise<T>,label="",waitMs=120_000):Promise<T> {
  const lock=join(basePath,".git","lane-pilot-integrate.lock");
  const deadline=Date.now()+waitMs;
  for(;;) {
    // The owner file: the pid on the first line, then what this integration merges, for whoever waits.
    try { await mkdir(lock); await writeFile(join(lock,"owner"),`${process.pid}\n${label.split("\n")[0]!.slice(0,300)}`); break; }
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      const info=await stat(lock).catch(()=>null);
      const ownerText=await readFile(join(lock,"owner"),"utf8").catch(()=>"");
      const owner=Number.parseInt(ownerText,10);
      // A lock without an owner file is either being created right now or was left by an older Lane Pilot.
      const orphaned=Number.isInteger(owner)&&owner>0&&owner!==process.pid&&!ownerAlive(owner);
      const legacy=!Number.isInteger(owner)&&info!==null&&Date.now()-info.mtimeMs>5_000&&!(await readdir(lock).catch(()=>[])).length;
      if(orphaned||legacy||(info&&Date.now()-info.mtimeMs>600_000)) { await rm(lock,{recursive:true,force:true}); continue; }
      if(Date.now()>deadline) throw new BaseLockBusyError(ownerText.split("\n")[1]?.trim()||null);
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
export async function integrateWorktree(input:{basePath:string;worktreePath:string;message:string;removeWorktree?:boolean;lockWaitMs?:number}):Promise<GitIntegration> {
  const fail=(reason:string):GitIntegration=>({status:"failed",commit:null,conflicts:[],reason});
  const dirty=git(input.worktreePath,["status","--porcelain","--untracked-files=all"]);
  if(!dirty.ok) return fail(`worktree status: ${dirty.reason}`);
  if(dirty.stdout.trim()) {
    const add=git(input.worktreePath,["add","-A"]);
    if(!add.ok) return fail(`worktree add: ${add.reason}`);
    // The project's own git hooks run here as they do for any commit and for the merge below: a hook
    // that rejects the writer's work fails the attempt with its output, and the retry has to satisfy it.
    const commit=git(input.worktreePath,[...identity(input.worktreePath),"commit","-q","-m",input.message]);
    if(!commit.ok) return fail(`project git hook or commit rejected the writer's work: ${commit.reason.split("\n").slice(-12).join("\n")}`);
  }
  const head=git(input.worktreePath,["rev-parse","HEAD"]);
  if(!head.ok) return fail(`worktree head: ${head.reason}`);
  const sha=head.stdout.trim();
  const branch=git(input.worktreePath,["rev-parse","--abbrev-ref","HEAD"]).stdout.trim();
  let result:GitIntegration;
  try { result=await withBaseLock(input.basePath,()=>merge(input.basePath,sha,input.message),input.message,input.lockWaitMs); }
  catch(error) {
    if(!(error instanceof BaseLockBusyError)) throw error;
    // The writer's work stays committed in its worktree; the next try merges it.
    return {status:"busy",commit:sha,conflicts:[],reason:error.message,holder:error.holder};
  }
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
  // Git refuses to merge over uncommitted edits of the same files in main (another agent or the PM
  // works there); name those files so the retry is understood, instead of a bare "merge failed".
  if(!conflicts.length&&/would be overwritten by merge/.test(merged.reason)) {
    const overwritten=merged.reason.split("\n").filter((line)=>/^\t/.test(line)).map((line)=>line.trim()).filter(Boolean);
    if(overwritten.length) return {status:"conflict",commit:null,conflicts:overwritten,reason:"base checkout has uncommitted changes in files this attempt also changes"};
  }
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

async function mirrorNodeModules(input:{baseReal:string;worktreePath:string;dir:string}):Promise<boolean> {
  const base=join(input.baseReal,input.dir,"node_modules"), target=join(input.worktreePath,input.dir,"node_modules");
  if(!(await stat(base).catch(()=>null))?.isDirectory()) return false;
  if(!(await stat(dirname(target)).catch(()=>null))?.isDirectory()||await lstat(target).catch(()=>null)) return false;
  const inRepo=(path:string)=>(path===input.baseReal||path.startsWith(`${input.baseReal}/`))&&!path.startsWith(`${base}/`);
  await mkdir(target);
  const linkEntry=async(rel:string[])=>{
    const source=join(base,...rel), destination=join(target,...rel);
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
    if(name.startsWith("@")&&!(await lstat(join(base,name))).isSymbolicLink()&&(await stat(join(base,name))).isDirectory()) {
      await mkdir(join(target,name));
      for(const child of await readdir(join(base,name))) await linkEntry([name,child]);
    } else {
      await linkEntry([name]);
    }
  }
  return true;
}

export async function prepareWorktree(input:{basePath:string;worktreePath:string}):Promise<{linked:string[]}> {
  await installBaseDependencies(input.basePath);
  const baseReal=await realpath(input.basePath).catch(()=>input.basePath);
  if(!(await stat(join(baseReal,"node_modules")).catch(()=>null))?.isDirectory()||await lstat(join(input.worktreePath,"node_modules")).catch(()=>null)) return {linked:[]};
  const common=git(input.worktreePath,["rev-parse","--git-common-dir"]);
  if(!common.ok) return {linked:[]};
  const dir=common.stdout.trim();
  const exclude=join(isAbsolute(dir)?dir:join(input.worktreePath,dir),"info","exclude");
  const current=await readFile(exclude,"utf8").catch(()=>"");
  const missing=["/node_modules","node_modules/"].filter((line)=>!current.split("\n").includes(line));
  if(missing.length) {
    await mkdir(join(exclude,".."),{recursive:true});
    await appendFile(exclude,`${current&&!current.endsWith("\n")?"\n":""}${missing.join("\n")}\n`);
  }
  const linked:string[]=[];
  const workspaces=await workspaceDirs(baseReal);
  for(const workspace of ["",...workspaces]) {
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
    if(!git(baseReal,["check-ignore","-q",dist]).ok) continue;
    await cp(join(baseReal,dist),join(input.worktreePath,dist),{recursive:true,dereference:false,errorOnExist:false,force:true});
    linked.push(dist);
  }
  return {linked};
}

/** Removes Lane Pilot's own worktree and its lane/ branch; other worktrees are left alone. */
export async function removeLaneWorktree(input:{basePath:string;worktreePath:string}):Promise<{removed:boolean}> {
  const branch=git(input.worktreePath,["rev-parse","--abbrev-ref","HEAD"]).stdout.trim();
  if(!branch.startsWith("lane/")) return {removed:false};
  const removed=git(input.basePath,["worktree","remove","--force",input.worktreePath]).ok;
  if(removed) git(input.basePath,["branch","-D",branch]);
  return {removed};
}
