import { z } from "zod";

const runPolicySchema=z.object({
  schemaVersion:z.literal(1),
  pools:z.object({provider:z.number().int().min(1).max(10),verification:z.number().int().min(1).max(10)}).strict(),
}).strict();

export type RunPolicy=z.infer<typeof runPolicySchema>;
export type RunExecutionProfile={schemaVersion:1;pools:RunPolicy["pools"];score:number;risk:"low"|"medium"|"high";sourceRisk:string;scoreAdapter:"task-risk-v1"};

function configuredPool(value:unknown,key:string,fallback:number):number {
  if(value===undefined||value===null||value==="")return fallback;
  const parsed=typeof value==="string"&&/^\d+$/.test(value)?Number(value):value;
  if(typeof parsed!=="number"||!Number.isInteger(parsed)||parsed<1||parsed>10)throw new Error(`${key} must be an integer from 1 to 10`);
  return parsed;
}

export function buildRunPolicy(settings:Record<string,unknown>):RunPolicy {
  return runPolicySchema.parse({schemaVersion:1,pools:{
    provider:configuredPool(settings["ops.pool_size"],"ops.pool_size",5),
    verification:configuredPool(settings["ops.verify_pool_size"],"ops.verify_pool_size",2),
  }});
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
  if(!Number.isInteger(limit)||limit<1||limit>10)throw new Error("concurrency limit must be an integer from 1 to 10");
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

export class RunWriterPool {
  private readonly active=new Map<string,number>();
  private readonly waiting=new Map<string,Array<()=>void>>();

  async acquire(runId:string,limit:number):Promise<()=>void> {
    if(!Number.isInteger(limit)||limit<1||limit>10)throw new Error("provider pool limit must be an integer from 1 to 10");
    const count=this.active.get(runId)??0;
    if(count<limit)this.active.set(runId,count+1);
    else await new Promise<void>(resolve=>{
      const queue=this.waiting.get(runId)??[];
      queue.push(resolve);this.waiting.set(runId,queue);
    });
    let released=false;
    return ()=>{
      if(released)return;released=true;
      const queue=this.waiting.get(runId);
      const next=queue?.shift();
      if(queue?.length===0)this.waiting.delete(runId);
      if(next)next();
      else {
        const active=this.active.get(runId)??0;
        if(active<=1)this.active.delete(runId);else this.active.set(runId,active-1);
      }
    };
  }
}
