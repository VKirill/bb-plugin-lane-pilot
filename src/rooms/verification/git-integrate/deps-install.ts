import { createHash } from "node:crypto";
import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bestEffort, isFsAbsent, orMiss, parseJsonOr, readTextOrNull, spawnAsync, statOrNull } from "@lane-pilot/kit";
import { git } from "./git-core";
import { withInstallLock } from "./locks";

/**
 * A git worktree has no ignored dependencies; link the base checkout's node_modules so the
 * writer's checks run, and keep the link out of git through the shared info/exclude.
 */
const installing=new Map<string,Promise<void>>();

/** Who touched the shared dependency store, when and with what (SMA k_lib_storejournal): one JSON line per install into ~/.lane-pilot/store-journal.jsonl. */
export const STORE_JOURNAL = join(homedir(), ".lane-pilot", "store-journal.jsonl");
const STORE_JOURNAL_MAX = 2000;

export async function journalStoreInstall(entry:{basePath:string;dir:string;command:string;trigger?:string|null;exitCode:number|null}):Promise<void> {
  const lockSha256=createHash("sha256").update(await readTextOrNull(join(entry.dir,"package-lock.json")) ?? "").digest("hex");
  const line=JSON.stringify({at:new Date().toISOString(),basePath:entry.basePath,dir:entry.dir,command:entry.command,lockSha256,trigger:entry.trigger??null,exitCode:entry.exitCode});
  await bestEffort(console.warn,"store journal",(async()=>{
    await mkdir(dirname(STORE_JOURNAL),{recursive:true});
    const lines=(await readTextOrNull(STORE_JOURNAL) ?? "").split("\n").filter(Boolean);
    lines.push(line);
    await writeFile(STORE_JOURNAL,`${lines.slice(-STORE_JOURNAL_MAX).join("\n")}\n`);
  })(),undefined);
}

/**
 * Installs a project's npm dependencies once, in the main checkout, from its lockfile. `npm ci` never
 * rewrites package-lock.json, so a writer no longer has to run `npm install` and trip the owns check,
 * and the offline verification sandbox finds the packages already in place.
 */
export async function installBaseDependencies(basePath:string,trigger?:string):Promise<void> {
  const installed=async()=>(await statOrNull(join(basePath,"node_modules")))?.isDirectory()??false;
  if(!(await statOrNull(join(basePath,"package-lock.json")))?.isFile()) return;
  if(await installed()&&!await dependenciesStale(basePath)) return;
  const install=async()=>{
    if(await installed()) { await refreshStaleDependencies(basePath,basePath,trigger); return; }
    const run=await spawnAsync("npm",["ci","--no-audit","--no-fund"],{cwd:basePath,timeout:540_000,maxBuffer:16<<20});
    await journalStoreInstall({basePath,dir:basePath,command:"npm ci --no-audit --no-fund",trigger,exitCode:run.status});
  };
  const running=installing.get(basePath)??withInstallLock(basePath,install).finally(()=>installing.delete(basePath));
  installing.set(basePath,running);
  await running;
}

/**
 * The packages of a checkout are older than its lockfile: npm writes node_modules/.package-lock.json on every install, and a merge
 * that changes package-lock.json writes that file after it. Only a missing node_modules was installed, so a merged task's new
 * dependency stayed out of main's packages and so out of every worktree mirrored from them: SelfyStudio's site-og-renderer added
 * satori and @resvg/resvg-js at 11:54Z on 2026-10-24, and site-seo-shared, prepared a minute later, failed `npm run typecheck`
 * with TS2307 in a file it did not own (its writer then shimmed the modules); main had them only after someone installed by hand.
 */
export async function dependenciesStale(dir:string):Promise<boolean> {
  const [lock,packages]=await Promise.all([statOrNull(join(dir,"package-lock.json")),statOrNull(join(dir,"node_modules",".package-lock.json"))]);
  return Boolean(lock?.isFile()&&packages?.isFile()&&lock.mtimeMs>packages.mtimeMs);
}

/** A lockfile whose install failed, by its mtime: it is not tried again on every worktree until the lockfile changes. */
const failedInstalls=new Map<string,number>();

/**
 * Installs what a newer lockfile adds to existing packages. `npm install --no-save` neither rewrites package-lock.json nor clears
 * node_modules the way `npm ci` does, so the worktrees whose packages are links into this one keep working while it runs.
 */
export async function refreshStaleDependencies(dir:string,basePath?:string,trigger?:string):Promise<void> {
  if(!await dependenciesStale(dir)) return;
  const lock=(await stat(join(dir,"package-lock.json"))).mtimeMs;
  if(failedInstalls.get(dir)===lock) return;
  const run=await spawnAsync("npm",["install","--no-save","--no-audit","--no-fund"],{cwd:dir,timeout:540_000,maxBuffer:16<<20});
  await journalStoreInstall({basePath:basePath??dir,dir,command:"npm install --no-save --no-audit --no-fund",trigger,exitCode:run.status});
  if(run.status!==0) { failedInstalls.set(dir,lock); return; }
  // npm leaves its record as it was when nothing had to change; touched, the checkout reads as installed until the next lockfile.
  const now=new Date();
  await bestEffort(console.warn, `dependencies utimes ${dir}`, utimes(join(dir,"node_modules",".package-lock.json"),now,now), undefined);
}

/**
 * Rebuilds, in a checkout, the workspace packages changed between two commits that are consumed through their
 * build output (they have dist/ and a build script). In the base checkout after a merge: a writer's worktree copies
 * dist/ from there; left stale, the next writer's typecheck failed until someone rebuilt main by hand (SelfyStudio,
 * 2026-10-02). In a worktree after the replay on main: its dist/ is its own copy and does not follow the replayed sources.
 */
export async function rebuildChangedPackages(basePath:string,before:string,after:string):Promise<Array<{dir:string;ok:boolean;detail:string|null}>> {
  const diff=await git(basePath,["diff","--name-only",`${before}..${after}`]);
  if(!diff.ok) return [];
  const changed=diff.stdout.split("\n").map((line)=>line.trim()).filter(Boolean);
  const out:Array<{dir:string;ok:boolean;detail:string|null}>=[];
  for(const dir of await workspaceDirs(basePath)) {
    // Markdown is no build input: a docs merge must not rebuild every package whose docs/ it touched.
    if(!changed.some((file)=>file.startsWith(`${dir}/`)&&!file.startsWith(`${dir}/dist/`)&&!file.endsWith(".md"))) continue;
    if(!(await statOrNull(join(basePath,dir,"dist")))?.isDirectory()) continue;
    const manifest=parseJsonOr(await readTextOrNull(join(basePath,dir,"package.json")) ?? "", null) as {scripts?:Record<string,string>}|null;
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
export async function nestedPackageDirs(baseReal:string,worktreePath:string,workspaces:readonly string[]):Promise<string[]> {
  const listed=await git(worktreePath,["ls-files","-z","--",":(glob)**/package.json"]);
  if(!listed.ok) return [];
  const taken=new Set(workspaces);
  const dirs:string[]=[];
  for(const file of listed.stdout.split("\0").filter(Boolean)) {
    const dir=dirname(file);
    if(dir==="."||taken.has(dir)||dir.split("/").length>3||dir.split("/").includes("node_modules")) continue;
    if((await statOrNull(join(baseReal,dir,"node_modules")))?.isDirectory()) dirs.push(dir);
    if(dirs.length>=20) break;
  }
  return [...new Set(dirs)].sort();
}

/** The workspace folders of a monorepo (`apps/*`, a literal path), from the base package.json; [] when none. */
export async function workspaceDirs(basePath:string):Promise<string[]> {
  const manifest=parseJsonOr(await readTextOrNull(join(basePath,"package.json")) ?? "", null) as {workspaces?:string[]|{packages?:string[]}}|null;
  const patterns=Array.isArray(manifest?.workspaces)?manifest.workspaces:manifest?.workspaces?.packages??[];
  const dirs:string[]=[];
  for(const pattern of patterns) {
    if(typeof pattern!=="string"||pattern.startsWith("/")||pattern.includes("..")) continue;
    if(pattern.endsWith("/*")) {
      const parent=pattern.slice(0,-2);
      for(const name of await orMiss(readdir(join(basePath,parent)),[] as string[],isFsAbsent)) {
        if(!name.startsWith(".")&&(await statOrNull(join(basePath,parent,name,"package.json")))?.isFile()) dirs.push(join(parent,name));
      }
    } else if(!pattern.includes("*")&&(await statOrNull(join(basePath,pattern,"package.json")))?.isFile()) dirs.push(pattern);
  }
  return [...new Set(dirs)].sort();
}
