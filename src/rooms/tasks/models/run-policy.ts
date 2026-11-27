import { z } from "zod";

const runPolicySchema=z.object({
  schemaVersion:z.literal(1),
  pools:z.object({provider:z.number().int().min(1).max(15),verification:z.number().int().min(1).max(10)}).strict(),
  /** The writer turn ceiling frozen at run creation (SMA m_restart_scoped): absent when writer.max_turns is unset, 0 or off; absent means no ceiling. */
  maxTurns:z.number().int().min(1).max(10_000).optional(),
}).strict();

export type RunPolicy=z.infer<typeof runPolicySchema>;
export type RunExecutionProfile={schemaVersion:1;pools:RunPolicy["pools"];score:number;risk:"low"|"medium"|"high";sourceRisk:string;scoreAdapter:"task-risk-v1"};

/** Writers at once per run: 15 by default and at most since 2026-10-04 (the owner runs batches of 10-15 tasks). */
const MAX_POOL=15;

function configuredPool(value:unknown,key:string,fallback:number):number {
  if(value===undefined||value===null||value==="")return fallback;
  const parsed=typeof value==="string"&&/^\d+$/.test(value)?Number(value):value;
  if(typeof parsed!=="number"||!Number.isInteger(parsed)||parsed<1||parsed>MAX_POOL)throw new Error(`${key} must be an integer from 1 to ${MAX_POOL}`);
  return parsed;
}

/**
 * No turn ceiling by default (owner 2026-11-23: large tasks legitimately run 300+ tool calls, and cutting at 300 killed
 * finished-in-all-but-name work; stalls are caught by the silence and spin sweeps). Explicit writer.max_turns 1-10000 opts in.
 */
export const WRITER_TURN_CEILING_DEFAULT:number|null=null;
export const WRITER_TURN_CEILING_MAX=10_000;

/** The turn ceiling a setting value gives: a whole number 1-10000 when set; unset, empty, 0 or off is no ceiling. */
export function turnCeilingOf(value:unknown):{ceiling:number|null;invalid:boolean} {
  if(value===undefined||value===null||value==="")return {ceiling:WRITER_TURN_CEILING_DEFAULT,invalid:false};
  if(value===0||value==="0"||value==="off")return {ceiling:null,invalid:false};
  const parsed=typeof value==="string"&&/^\d+$/.test(value.trim())?Number(value.trim()):value;
  if(typeof parsed!=="number"||!Number.isInteger(parsed)||parsed<1||parsed>WRITER_TURN_CEILING_MAX)return {ceiling:null,invalid:true};
  return {ceiling:parsed,invalid:false};
}

const warnedCeilings=new Set<string>();

/** The policy of a new run. writer.max_turns is frozen at creation (unset, 0 or off freezes none); a bad value never blocks run creation (no ceiling, said once). */
export function buildRunPolicy(settings:Record<string,unknown>,warn?:(line:string)=>void):RunPolicy {
  const turns=turnCeilingOf(settings["writer.max_turns"]);
  if(turns.invalid){
    const raw=String(settings["writer.max_turns"]);
    if(!warnedCeilings.has(raw)){warnedCeilings.add(raw);warn?.(`Lane Pilot: writer.max_turns=${raw.slice(0,40)} is not a whole number from 1 to ${WRITER_TURN_CEILING_MAX}; the writer has no turn ceiling`)}
  }
  return runPolicySchema.parse({schemaVersion:1,pools:{
    provider:configuredPool(settings["ops.pool_size"],"ops.pool_size",15),
    verification:configuredPool(settings["ops.verify_pool_size"],"ops.verify_pool_size",2),
  },...(turns.ceiling!==null?{maxTurns:turns.ceiling}:{})});
}

export function parseRunPolicy(value:unknown):RunPolicy {
  return runPolicySchema.parse(value);
}

export function shouldResumeWorktreeHolder(attempt:{
  state:string; holder_thread_id?:string|null; thread_id?:string|null; workspace_path?:string|null;
}):boolean {
  return Boolean(attempt.holder_thread_id)
    && !attempt.thread_id
    && (attempt.state==="spawn_requested" || attempt.state==="spawn_unknown");
}

export function shouldScanLostWorktreeHolder(attempt:{
  state:string; holder_thread_id?:string|null; thread_id?:string|null;
}):boolean {
  return !attempt.holder_thread_id
    && !attempt.thread_id
    && (attempt.state==="spawn_requested" || attempt.state==="spawn_unknown");
}

export function shouldReconcileAttemptThread(
  state:string,
  attempt?:{holder_thread_id?:string|null; thread_id?:string|null; workspace_path?:string|null},
):boolean {
  if (state==="queued") return false;
  if (attempt && shouldResumeWorktreeHolder({state,...attempt})) return false;
  return true;
}

export function buildRunExecutionProfile(risk:unknown,policy:RunPolicy):RunExecutionProfile {
  if(typeof risk!=="string")throw new Error("task risk is required to build run-v2 execution profile");
  const score=({low:2,medium:5,high:8,critical:10} as Record<string,number>)[risk];
  if(score===undefined)throw new Error(`unsupported task risk for run-v2 profile: ${risk}`);
  return {schemaVersion:1,pools:policy.pools,score,risk:risk==="critical"?"high":risk as RunExecutionProfile["risk"],sourceRisk:risk,scoreAdapter:"task-risk-v1"};
}

export async function mapBounded<T,R>(items:readonly T[],limit:number,work:(item:T,index:number)=>Promise<R>):Promise<R[]> {
  if(!Number.isInteger(limit)||limit<1||limit>MAX_POOL)throw new Error(`concurrency limit must be an integer from 1 to ${MAX_POOL}`);
  const results=new Array<R>(items.length);
  let cursor=0;
  const worker=async()=>{
    while(true){
      const index=cursor++;
      if(index>=items.length)return;
      results[index]=await work(items[index]!,index);
    }
  };
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return results;
}
