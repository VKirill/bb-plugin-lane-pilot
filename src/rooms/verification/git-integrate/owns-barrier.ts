import { chmod, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { bestEffort, fileAllowedByOwns, fileBlockedByNeverTouch, isFsAbsent, lstatOrNull, readTextOrNull } from "@lane-pilot/kit";
import { isOwnershipNoise } from "@lane-pilot/settings-catalog";
import { satelliteOf } from "../../contracts/ownership";
import { git } from "./git-core";
import { withBaseLock } from "./locks";

/**
 * The owns-paths barrier state (F-01): the tracked files an attempt's worktree made read-only, kept in the
 * worktree's git admin dir so it is never a change of the writer's and goes away with the worktree.
 */
const OWNS_BARRIER_STATE = "lane-pilot-owns-barrier.json";

type LockedFile = { path:string; mode:number };

async function barrierStatePath(worktreePath:string):Promise<string> {
  const stateFile=await git(worktreePath,["rev-parse","--git-path",OWNS_BARRIER_STATE]);
  const raw=stateFile.ok?stateFile.stdout.trim():"";
  return raw?resolve(worktreePath,raw):"";
}

/** The recorded files; a state that cannot be read as one is an error, never an empty list that would lose their original modes. */
async function readBarrierState(statePath:string):Promise<LockedFile[]> {
  const raw=await readTextOrNull(statePath);
  if (!raw) return [];
  const rows:unknown=JSON.parse(raw);
  if (!Array.isArray(rows)||!rows.every((row)=>typeof row?.path==="string"&&typeof row?.mode==="number")) throw new Error(`owns barrier state ${statePath} is not a list of {path, mode}`);
  return rows as LockedFile[];
}

/** Written whole or not at all (a temporary file renamed over it): a cut-off write never leaves half a list. */
async function writeBarrierState(statePath:string, rows:LockedFile[]):Promise<void> {
  if (!rows.length) {
    await unlink(statePath).catch((cause:unknown) => { if (!isFsAbsent(cause)) throw cause; });
    return;
  }
  await mkdir(dirname(statePath),{recursive:true});
  const temporary=`${statePath}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(rows));
  await rename(temporary,statePath);
}

/**
 * The file a tracked path names, only when it is a regular file inside the worktree: a folder on its way that a writer
 * swapped for a symlink would otherwise send chmod out of the worktree.
 */
async function fileInside(rootReal:string, worktreePath:string, path:string):Promise<{target:string;mode:number}|null> {
  const full=join(worktreePath,path);
  const st=await lstatOrNull(full);
  if (!st?.isFile()) return null;
  const target=await realpath(full).catch((cause:unknown) => { if (isFsAbsent(cause)) return null; throw cause; });
  return target&&target.startsWith(rootReal+sep) ? { target, mode:st.mode&0o777 } : null;
}

/**
 * Tracked files outside the contract lose their write bits, so a writer that reaches for one is refused by the OS
 * instead of producing a rejection after the fact. Satellites (the test or locale of an owned area) and ownership
 * noise (bookkeeping, caches, build output) stay writable; never_touch is always locked.
 *
 * Called again with a changed contract (owns_paths widened in place), the barrier follows it: files the new contract
 * allows get their recorded original mode back, newly refused ones are locked. The state is the journal: a file is
 * written into it with its original mode before its mode changes, so a pass cut off anywhere leaves every changed file
 * restorable, and an original mode is never read again from a file the barrier already changed.
 */
export async function applyOwnsBarrier(input:{worktreePath:string;ownsPaths:string[];neverTouch:string[];signal?:AbortSignal}):Promise<{locked:number;unlocked:number;failed:string[]}> {
  if (!input.ownsPaths.length) return { locked:0, unlocked:0, failed:[] };
  const [listed,statePath]=await Promise.all([git(input.worktreePath,["ls-files","-z","--cached"]),barrierStatePath(input.worktreePath)]);
  if (!listed.ok||!statePath) return { locked:0, unlocked:0, failed:[] };
  const rootReal=await realpath(input.worktreePath);
  const files=listed.stdout.split("\0").filter(Boolean);
  const anchors=files.filter((path)=>fileAllowedByOwns(path,input.ownsPaths)&&!fileBlockedByNeverTouch(path,input.neverTouch));
  const owned=new Set(anchors);
  const allowed=(path:string) => !fileBlockedByNeverTouch(path,input.neverTouch)
    && (owned.has(path)||fileAllowedByOwns(path,input.ownsPaths)||satelliteOf(path,anchors)||isOwnershipNoise(path));
  const prior=await readBarrierState(statePath);
  const recorded=new Set(prior.map((row)=>row.path));
  const lock:LockedFile[]=[];
  for (const path of files) {
    if (allowed(path)||recorded.has(path)) continue;
    const file=await fileInside(rootReal,input.worktreePath,path);
    if (!file||!(file.mode&0o222)) continue;
    lock.push({ path, mode:file.mode });
  }
  const keep=prior.filter((row)=>!allowed(row.path));
  const unlock=prior.filter((row)=>allowed(row.path));
  // A cancelled request stops before its first write (nothing changed) and before each chmod (the journal stays, so the
  // next pass or a lift finishes from the recorded modes); it reports a failure, never a done pass.
  const stopIfCancelled=() => input.signal?.throwIfAborted();
  stopIfCancelled();
  // Recorded first: a pass cut off after this line leaves only rows that put a file back to the mode it already has.
  if (lock.length) await writeBarrierState(statePath,[...prior,...lock]);
  const notLocked:string[]=[];
  for (const row of [...keep,...lock]) {
    stopIfCancelled();
    const file=await fileInside(rootReal,input.worktreePath,row.path);
    if (file&&file.mode&0o222&&!await chmod(file.target,row.mode&~0o222).then(()=>true,()=>false)) notLocked.push(row.path);
  }
  const stuck:LockedFile[]=[];
  for (const row of unlock) {
    stopIfCancelled();
    const file=await fileInside(rootReal,input.worktreePath,row.path);
    // A file the writer deleted has nothing to give back; one that cannot be given back stays recorded.
    if (!file) continue;
    const ok=await chmod(file.target,row.mode).then(()=>true,()=>false);
    if (!ok) stuck.push(row);
  }
  if (lock.length||unlock.length) await writeBarrierState(statePath,[...keep,...lock,...stuck]);
  // Either way the barrier does not match the contract: `failed` says so (the records stay, so a lift still restores them).
  // The bind-time barrier keeps its old best-effort reading of it; a contract changed in place refuses (applyLaneOwnsBarrier).
  return { locked:lock.length, unlocked:unlock.length-stuck.length, failed:[...stuck.map((row)=>row.path),...notLocked] };
}

/**
 * The barrier brought to a changed contract, for an attempt's lane worktree only. Lane Pilot sets the barrier only
 * on a worktree it created under the lane root (gitPrepareWorktree after gitCreateWorktree), so a path outside it
 * (a live folder, a bound workspace) or a checkout that is no linked worktree never had one, and nothing there changes.
 */
export async function applyLaneOwnsBarrier(input:{laneRoot:string;worktreePath:string;ownsPaths:string[];neverTouch:string[];signal?:AbortSignal}):Promise<{status:"applied"|"not_lane_worktree";locked:number;unlocked:number}> {
  const none={ status:"not_lane_worktree" as const, locked:0, unlocked:0 };
  const root=await realpath(input.laneRoot).catch((cause:unknown) => { if (isFsAbsent(cause)) return null; throw cause; });
  if (!root) return none;
  const path=await realpath(input.worktreePath);
  if (!path.startsWith(root+sep)) return none;
  const [dir,common]=await Promise.all([git(path,["rev-parse","--absolute-git-dir"]),git(path,["rev-parse","--git-common-dir"])]);
  if (!dir.ok||!common.ok) throw new Error(`owns barrier: ${path} is not readable as a git checkout`);
  const [dirReal,commonReal]=await Promise.all([realpath(dir.stdout.trim()),realpath(resolve(path,common.stdout.trim()))]);
  if (dirReal===commonReal) return none;
  // One pass at a time per worktree, across processes (the checkout's own lock, as integration takes it): a pass still
  // running after its caller timed out finishes before the rollback that caller sends next reads the state.
  const done=await withBaseLock(path,()=>applyOwnsBarrier({ worktreePath:path, ownsPaths:input.ownsPaths, neverTouch:input.neverTouch, signal:input.signal }),"owns barrier",50_000);
  // A file whose mode could not follow the contract is a failed sync, never «applied» (its record stays for a lift).
  if (done.failed.length) throw new Error(`owns barrier could not set the mode of ${done.failed.slice(0,10).join(", ")}`);
  return { status:"applied", locked:done.locked, unlocked:done.unlocked };
}

/** Give the files the barrier locked their write bits back; integration calls it before touching the worktree. */
export async function liftOwnsBarrier(worktreePath:string):Promise<{restored:number}> {
  const statePath=await barrierStatePath(worktreePath);
  if (!statePath) return { restored: 0 };
  const rows=await readBarrierState(statePath);
  if (!rows.length) { await bestEffort(console.warn, `owns barrier state ${statePath}`, writeBarrierState(statePath,[]), undefined); return { restored: 0 }; }
  const rootReal=await realpath(worktreePath);
  let restored=0;
  // A file not restored (chmod refused, or its path now leaves the worktree through a symlink) keeps its record;
  // only a path with nothing at it (the writer deleted the file) has no mode left to give back.
  const kept:LockedFile[]=[];
  for (const row of rows) {
    if (!await lstatOrNull(join(worktreePath,row.path))) continue;
    const file=await fileInside(rootReal,worktreePath,row.path);
    const ok=file?await bestEffort(console.warn, `owns barrier restore ${row.path}`, chmod(file.target,row.mode).then(()=>true), false):false;
    if (ok) restored+=1; else kept.push(row);
  }
  await bestEffort(console.warn, `owns barrier state ${statePath}`, writeBarrierState(statePath,kept), undefined);
  return { restored };
}
