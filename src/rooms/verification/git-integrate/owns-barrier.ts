import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { bestEffort, fileAllowedByOwns, fileBlockedByNeverTouch, lstatOrNull, readTextOrNull } from "@lane-pilot/kit";
import { isOwnershipNoise } from "@lane-pilot/settings-catalog";
import { satelliteOf } from "../../contracts/ownership";
import { git } from "./git-core";

/**
 * The owns-paths barrier state (F-01): the tracked files an attempt's worktree made read-only, kept in the
 * worktree's git admin dir so it is never a change of the writer's and goes away with the worktree.
 */
const OWNS_BARRIER_STATE = "lane-pilot-owns-barrier.json";

/**
 * After a worktree is bound: tracked files outside the contract lose their write bits, so a writer that reaches
 * for one is refused by the OS instead of producing a rejection after the fact. Satellites (the test or locale
 * of an owned area) and ownership noise (bookkeeping, caches, build output) stay writable.
 */
export async function applyOwnsBarrier(input:{worktreePath:string;ownsPaths:string[];neverTouch:string[]}):Promise<{locked:number}> {
  if (!input.ownsPaths.length) return { locked: 0 };
  const [listed,stateFile]=await Promise.all([
    git(input.worktreePath,["ls-files","-z","--cached"]),
    git(input.worktreePath,["rev-parse","--git-path",OWNS_BARRIER_STATE]),
  ]);
  const raw=stateFile.ok?stateFile.stdout.trim():"";
  const statePath=raw?resolve(input.worktreePath,raw):"";
  if (!listed.ok||!statePath) return { locked: 0 };
  const files=listed.stdout.split("\0").filter(Boolean);
  const owned=new Set(files.filter((path)=>fileAllowedByOwns(path,input.ownsPaths)&&!fileBlockedByNeverTouch(path,input.neverTouch)));
  const anchors=[...owned];
  const locked:{path:string;mode:number}[]=[];
  for (const path of files) {
    if (!fileBlockedByNeverTouch(path,input.neverTouch)&&(owned.has(path)||satelliteOf(path,anchors)||isOwnershipNoise(path))) continue;
    const st=await lstatOrNull(join(input.worktreePath,path));
    if (!st?.isFile()||!(st.mode&0o222)) continue;
    locked.push({path,mode:st.mode&0o777});
  }
  if (!locked.length) return { locked: 0 };
  for (const row of locked) await bestEffort(console.warn, `owns barrier chmod ${row.path}`, chmod(join(input.worktreePath,row.path),row.mode&~0o222), undefined);
  await bestEffort(console.warn, `owns barrier state dir ${statePath}`, mkdir(dirname(statePath),{recursive:true}), undefined);
  await bestEffort(console.warn, `owns barrier state ${statePath}`, writeFile(statePath,JSON.stringify(locked)), undefined);
  return { locked: locked.length };
}

/** Give the files the barrier locked their write bits back; integration calls it before touching the worktree. */
export async function liftOwnsBarrier(worktreePath:string):Promise<{restored:number}> {
  const stateFile=await git(worktreePath,["rev-parse","--git-path",OWNS_BARRIER_STATE]);
  if (!stateFile.ok) return { restored: 0 };
  const statePath=resolve(worktreePath,stateFile.stdout.trim());
  const raw=await readTextOrNull(statePath);
  if (!raw) return { restored: 0 };
  let rows:{path:string;mode:number}[]=[];
  try { rows=JSON.parse(raw) as typeof rows; } catch { rows=[]; }
  let restored=0;
  for (const row of rows) {
    if (typeof row?.path!=="string"||typeof row?.mode!=="number") continue;
    const ok=await bestEffort(console.warn, `owns barrier restore ${row.path}`, chmod(join(worktreePath,row.path),row.mode).then(()=>true), false);
    if (ok) restored+=1;
  }
  await bestEffort(console.warn, `owns barrier state ${statePath}`, unlink(statePath), undefined);
  return { restored };
}
