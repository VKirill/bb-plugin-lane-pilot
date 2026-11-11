import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnAsync } from "@lane-pilot/kit";

/** The reason a baseInHead merge refused: main moved after the candidate took it in. */
export const BASE_MOVED = "base moved since the candidate took it in";
/** The reason an expectedHead merge refused: the worktree is not at the verified commit any more. */
export const HEAD_MOVED = "the candidate moved since it was verified";

export type GitIntegration = {
  status:"merged"|"up-to-date"|"conflict"|"failed"|"busy";
  commit:string|null;
  conflicts:string[];
  reason:string|null;
  /** With «busy»: what the integration holding the base checkout merges (its commit message). */
  holder?:string|null;
  /** The attempt was replayed on a main that had moved, and merged without another writer turn. */
  rebased?:boolean;
  /** Workspace packages rebuilt in the base checkout after the merge, with how each build ended. */
  rebuilt?:Array<{dir:string;ok:boolean;detail:string|null}>;
  /** With «conflict» and no files: the task's checks that went red on the attempt replayed on the moved main. */
  checks?:ReplayCheck[];
  /** With a replay red: the structured failure facts of the check that failed (the reason text names them too). */
  failureCode?:"verification_failed"|"verification_timeout";
  checkName?:string;
  /** With «merged»: main's HEAD before the merge (the merge commit's first parent), and what the merge changed there, deletions included. */
  base?:string|null;
  changed?:ChangedFile[];
};

/** One file a change touched: A added, M modified, D deleted, T type changed. */
export type ChangedFile = {path:string;status:string};

/** `git diff --name-status` between two commits, deletions included (SMA wall 4: a rollback names what it undoes). */
export async function changedBetween(cwd:string,from:string,to:string):Promise<ChangedFile[]> {
  const diff=await git(cwd,["diff","--name-status","-z","--no-renames",from,to]);
  if(!diff.ok) return [];
  const parts=diff.stdout.split("\0").filter(Boolean);
  const files:ChangedFile[]=[];
  for(let i=0;i+1<parts.length;i+=2) files.push({status:parts[i]![0]!,path:parts[i+1]!});
  return files;
}

export type ReplayCheck = {command:string;exitCode:number;stdout:string;stderr:string};
/**
 * What the checks run on the replayed attempt said: green, or the checks that are red. `environment`: no check is red, but some could
 * not run (the machine broke them, no sandbox) — that is not a pass, the merge waits, and the writer is not charged.
 */
export type ReplayCheckOutcome = {ok:true} | {ok:false;failed:ReplayCheck[];environment?:true};

/** The base checkout is held by a live integration; the caller waits and tries again instead of failing. */
export class BaseLockBusyError extends Error {
  constructor(readonly holder:string|null) {
    super(`another writer integration holds the base checkout${holder?`: ${holder}`:""}`);
    this.name="BaseLockBusyError";
  }
}
const FALLBACK_IDENTITY = ["-c", "user.name=Lane Pilot writer", "-c", "user.email=lane-pilot@localhost"];
/**
 * A git process that hit <git-dir>/index.lock names it only sometimes (macOS prints the path; Linux git 2.43 says
 * just «Unable to write index»), so the lock is named here and every such failure classes as infra, not as the
 * task's. `git rev-parse` itself never writes the index, so it answers even while the lock stands.
 */
export async function withIndexLockNote(cwd:string,reason:string):Promise<string> {
  if (reason.includes("index.lock")) return reason;
  const dir=await spawnAsync("git",["rev-parse","--absolute-git-dir"],{cwd,timeout:10_000,maxBuffer:1_000_000});
  const gitDir=dir.status===0?dir.stdout.trim():"";
  if (!gitDir||!existsSync(join(gitDir,"index.lock"))) return reason;
  return `${reason} (index.lock present)`;
}

export async function git(cwd:string,args:string[]) {
  const result=await spawnAsync("git",args,{cwd,timeout:60_000,maxBuffer:4_000_000});
  if(result.error) return {ok:false as const,stdout:"",reason:result.error.message};
  if(result.status!==0) return {ok:false as const,stdout:result.stdout??"",reason:await withIndexLockNote(cwd,(result.stderr||result.stdout||`git exited ${result.status}`).trim())};
  return {ok:true as const,stdout:result.stdout,reason:""};
}
/** The repository's own identity when set, otherwise a writer identity, so commits never fail on a bare host. */
export async function identity(cwd:string):Promise<string[]> {
  const email=await git(cwd,["config","user.email"]);
  return email.ok&&email.stdout.trim()?[]:FALLBACK_IDENTITY;
}
