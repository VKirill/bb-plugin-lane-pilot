import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAsync } from "../spawn-async";
import { prepareWorktree } from "./git-integrate";

/**
 * The integration gate's work on the machine that holds the project: the gate command, the commit it ran on, and the
 * bisect that names the first bad commit. The hub only decides and tells; it has no copy of the project (the project may
 * live on another host), so none of this runs there.
 */

const GATE_OUTPUT_LIMIT = 4 * 1024 * 1024;

export async function runGateOnHost(input:{basePath:string;command:string;timeoutSec:number}):Promise<{exitCode:number;stdout:string;stderr:string;head:string|null}> {
  const ran=await spawnAsync("/bin/bash",["-lc",input.command],{cwd:input.basePath,timeout:input.timeoutSec*1000,maxBuffer:64*1024*1024});
  const head=await spawnAsync("git",["rev-parse","HEAD"],{cwd:input.basePath,timeout:30_000});
  const killed=[ran.error?.message,ran.signal?`killed by ${ran.signal}`:null].filter(Boolean).join("; ");
  return {
    exitCode:ran.status??1,
    stdout:(ran.stdout??"").slice(-GATE_OUTPUT_LIMIT),
    stderr:[ran.stderr??"",killed].filter(Boolean).join("\n").slice(-GATE_OUTPUT_LIMIT),
    head:head.status===0&&head.stdout.trim()?head.stdout.trim():null,
  };
}

/**
 * `git bisect run` over goodSha..badSha in a scratch worktree of the base checkout, so the project's own checkout is never
 * moved off its branch while writers merge into it. The worktree gets the base's dependencies like a writer's.
 */
export async function bisectGateOnHost(input:{basePath:string;command:string;goodSha:string;badSha:string;timeoutSec:number}):Promise<{status:"found"|"none"|"failed";commit:string|null;reason:string|null}> {
  const dir=await mkdtemp(join(tmpdir(),"lp-gate-bisect-"));
  const scratch=join(dir,"wt");
  const git=(args:string[],cwd=scratch,timeout=60_000)=>spawnAsync("git",args,{cwd,timeout,maxBuffer:16*1024*1024});
  try {
    const added=await git(["worktree","add","--detach",scratch,input.badSha],input.basePath);
    if(added.status!==0) return {status:"failed",commit:null,reason:`worktree add: ${(added.stderr||added.stdout||"").trim().slice(0,300)}`};
    await prepareWorktree({basePath:input.basePath,worktreePath:scratch}).catch(()=>undefined);
    const start=await git(["bisect","start",input.badSha,input.goodSha]);
    if(start.status!==0) return {status:"failed",commit:null,reason:`bisect start: ${(start.stderr||start.stdout||"").trim().slice(0,300)}`};
    const run=await git(["bisect","run","/bin/bash","-lc",input.command],scratch,input.timeoutSec*1000);
    const match=`${run.stdout}\n${run.stderr}`.match(/([0-9a-f]{7,40}) is the first bad commit/);
    return match?{status:"found",commit:match[1]!,reason:null}:{status:"none",commit:null,reason:null};
  } finally {
    await git(["bisect","reset"]).catch(()=>undefined);
    await git(["worktree","remove","--force",scratch],input.basePath).catch(()=>undefined);
    await git(["worktree","prune"],input.basePath).catch(()=>undefined);
    await rm(dir,{recursive:true,force:true}).catch(()=>undefined);
  }
}
