import { appendFile, cp, lstat, mkdir, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isFsAbsent, lstatOrNull, orMiss, readTextOrNull, spawnAsync, statOrNull } from "@lane-pilot/kit";
import { git } from "./git-core";
import { withInstallLock } from "./locks";
import { dependenciesStale, installBaseDependencies, nestedPackageDirs, refreshStaleDependencies, workspaceDirs } from "./deps-install";
import { TASK_FOLDER_EXCLUDE } from "./task-folder";

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

/**
 * `topUp` adds to a mirror made before what the base has installed since: the packages a merged lockfile brought in (see
 * dependenciesStale) are missing from it, and a sticky writer's worktree, synced with main, kept failing on them.
 */
async function mirrorNodeModules(input:{baseReal:string;worktreePath:string;dir:string;topUp?:boolean;clone?:boolean}):Promise<boolean> {
  const base=join(input.baseReal,input.dir,"node_modules"), target=join(input.worktreePath,input.dir,"node_modules");
  if(!(await statOrNull(base))?.isDirectory()) return false;
  if(!(await statOrNull(dirname(target)))?.isDirectory()) return false;
  let existing=await lstatOrNull(target);
  // A worktree made before the clone rule, or by hand, holds links into the protected checkout: they go, and the mirror is remade.
  if(input.clone&&existing?.isSymbolicLink()) { await rm(target,{force:true}); existing=null; }
  if(input.clone&&existing?.isDirectory()) await dropLinksInto(target,base);
  if(existing&&!(input.topUp&&existing.isDirectory())) return false;
  const inRepo=(path:string)=>(path===input.baseReal||path.startsWith(`${input.baseReal}/`))&&!path.startsWith(`${base}/`);
  const has=async(rel:string[])=>Boolean(existing&&await lstatOrNull(join(target,...rel)));
  if(!existing) await mkdir(target);
  const linkEntry=async(rel:string[])=>{
    const source=join(base,...rel), destination=join(target,...rel);
    if(NODE_MODULES_WRITABLE_COPIES.has(rel.join("/"))) {
      await cp(source,destination,{recursive:true,dereference:true,errorOnExist:false}).catch(async()=>{ await mkdir(destination,{recursive:true}); });
      return;
    }
    const info=await lstat(source);
    if(info.isSymbolicLink()) {
      const real=await orMiss(realpath(source),null,isFsAbsent);
      if(real&&inRepo(real)) { await symlink(join(input.worktreePath,relative(input.baseReal,real)),destination,"dir"); return; }
    }
    const followed=await statOrNull(source);
    if(input.clone) { await cloneEntry(source,destination); return; }
    await symlink(source,destination,followed?.isDirectory()?"dir":"file");
  };
  for(const name of await readdir(base)) {
    if(NODE_MODULES_CACHE_DIRS.has(name)) { if(!await has([name])) await mkdir(join(target,name)); continue; }
    if(NODE_MODULES_NPM_STATE.has(name)&&!(await lstat(join(base,name))).isSymbolicLink()) {
      if(!await has([name])) await cp(join(base,name),join(target,name),{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:false});
      else if(name===".bin") for(const bin of await readdir(join(base,name))) {
        if(!await has([name,bin])) await cp(join(base,name,bin),join(target,name,bin),{dereference:false,verbatimSymlinks:true,errorOnExist:false});
      }
      continue;
    }
    if(name.startsWith("@")&&!(await lstat(join(base,name))).isSymbolicLink()&&(await stat(join(base,name))).isDirectory()) {
      if(!await has([name])) await mkdir(join(target,name));
      for(const child of await readdir(join(base,name))) if(!await has([name,child])) await linkEntry([name,child]);
    } else if(!await has([name])) {
      await linkEntry([name]);
    }
  }
  return !existing;
}

/**
 * A checkout under a macOS privacy-protected folder (~/Documents, ~/Desktop, ~/Downloads, iCloud Drive). A writer whose sandbox
 * may not read it hit every package linked from there: «EPERM: operation not permitted, open '…/Документы/…/node_modules/vitest/
 * vitest.mjs'» before any work (Оживить фото, acp-cursor writers T3 and T6, 2026-10-27). Its packages are cloned into the worktree.
 */
export function protectedCheckout(path:string, home=process.env.HOME??"", platform=process.platform):boolean {
  if(platform!=="darwin"||!home) return false;
  return ["Documents","Desktop","Downloads","Library/Mobile Documents"].some((dir)=>{ const root=join(home,dir); return path===root||path.startsWith(`${root}/`); });
}

/** Removes the entries of a mirrored node_modules (and of its @scope folders) that link into the base checkout's own. */
async function dropLinksInto(target:string, base:string):Promise<void> {
  for(const name of await orMiss(readdir(target),[] as string[],isFsAbsent)) {
    const path=join(target,name), info=await lstatOrNull(path);
    if(info?.isSymbolicLink()) { const real=await orMiss(realpath(path),"",isFsAbsent); if(real===base||real.startsWith(`${base}/`)) await rm(path,{force:true}); }
    else if(name.startsWith("@")&&info?.isDirectory()) await dropLinksInto(path,base);
  }
}

/** A copy-on-write clone on APFS (`cp -c`: no extra disk until a side writes), a plain copy if the volume cannot clone. */
async function cloneEntry(source:string, destination:string):Promise<void> {
  const cloned=await spawnAsync("cp",["-Rc",source,destination],{timeout:300_000,maxBuffer:1_000_000});
  if(cloned.status!==0) await cp(source,destination,{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:false,force:true});
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
  const current=await readTextOrNull(exclude) ?? "";
  const missing=extraLines.filter((line)=>!current.split("\n").includes(line));
  if(!missing.length) return;
  await mkdir(join(exclude,".."),{recursive:true});
  await appendFile(exclude,`${current&&!current.endsWith("\n")?"\n":""}${missing.join("\n")}\n`);
}

async function copyTaskItems(basePath:string, worktreePath:string):Promise<void> {
  const src=join(basePath,".agents","plans","items");
  if(!(await statOrNull(src))?.isDirectory()) return;
  const dest=join(worktreePath,".agents","plans","items");
  const srcReal=await orMiss(realpath(src),src,isFsAbsent);
  const destReal=await orMiss(realpath(dest),dest,isFsAbsent);
  if(srcReal===destReal) return;
  await mkdir(join(dest,".."),{recursive:true});
  // A file the repository tracks (a project-life commit added it) already sits in the worktree as committed: the base's
  // uncommitted edits of it are that stage's, and copied over it they went into the attempt's commit and blocked its merge.
  const tracked=new Set((await git(worktreePath,["ls-files","-z","--",".agents/plans/items"])).stdout.split("\0").filter(Boolean));
  await cp(src,dest,{recursive:true,dereference:false,errorOnExist:false,force:true,
    filter:(_from,to)=>!tracked.has(relative(worktreePath,to).replace(/\\/g,"/"))});
}
export async function linkWorktreeDependencies(input:{basePath:string;worktreePath:string}):Promise<{linked:string[]}> {
  await ensureInfoExclude(input.worktreePath, [TASK_FOLDER_EXCLUDE]);
  await copyTaskItems(input.basePath, input.worktreePath);
  await installBaseDependencies(input.basePath,input.worktreePath);
  const baseReal=await orMiss(realpath(input.basePath),input.basePath,isFsAbsent);
  const workspaces=await workspaceDirs(baseReal);
  const nested=await nestedPackageDirs(baseReal,input.worktreePath,workspaces);
  for(const dir of nested) {
    const path=join(baseReal,dir);
    if(await dependenciesStale(path)) await withInstallLock(path,()=>refreshStaleDependencies(path,baseReal,input.worktreePath));
  }
  const rootModules=(await statOrNull(join(baseReal,"node_modules")))?.isDirectory()??false;
  const clone=protectedCheckout(baseReal);
  if(await lstatOrNull(join(input.worktreePath,"node_modules"))) {
    if(baseReal!==await orMiss(realpath(input.worktreePath),input.worktreePath,isFsAbsent)) {
      for(const dir of ["",...workspaces,...nested]) await mirrorNodeModules({baseReal,worktreePath:input.worktreePath,dir,topUp:true,clone});
    }
    return {linked:[]};
  }
  if(!rootModules&&!nested.length) return {linked:[]};
  const exclude=await infoExcludePath(input.worktreePath);
  if(!exclude) return {linked:[]};
  const current=await readTextOrNull(exclude) ?? "";
  // Tool caches the checks write (vitest's .vite/ inside a package) stay out of the writer's commit and of main.
  const missing=["/node_modules","node_modules/",".vite/",".vitest/",".turbo/",".parcel-cache/"].filter((line)=>!current.split("\n").includes(line));
  if(missing.length) {
    await mkdir(join(exclude,".."),{recursive:true});
    await appendFile(exclude,`${current&&!current.endsWith("\n")?"\n":""}${missing.join("\n")}\n`);
  }
  const linked:string[]=[];
  for(const workspace of ["",...workspaces,...nested]) {
    if(await mirrorNodeModules({baseReal,worktreePath:input.worktreePath,dir:workspace,clone})) linked.push(workspace?join(workspace,"node_modules"):"node_modules");
  }
  // Workspace packages are consumed through their ignored build output (exports → dist/). A fresh
  // worktree has none, so every check importing a sibling package would fail; each worktree gets its
  // own copy, and a build inside the worktree never writes into the base checkout or another lane.
  // Nuxt apps also need their generated .nuxt/ (tsconfig, types): without it vitest stopped at
  // «Failed to load tsconfig '.nuxt/tsconfig.json'» in SelfyStudio's marketing app (2026-10-02).
  for(const workspace of workspaces) for(const generated of ["dist",".nuxt"]) {
    const dist=join(workspace,generated);
    if(!(await statOrNull(join(baseReal,dist)))?.isDirectory()||await lstatOrNull(join(input.worktreePath,dist))) continue;
    if(!(await git(baseReal,["check-ignore","-q",dist])).ok) continue;
    await cp(join(baseReal,dist),join(input.worktreePath,dist),{recursive:true,dereference:false,errorOnExist:false,force:true});
    linked.push(dist);
  }
  return {linked};
}
