import { spawn } from "node:child_process";

export type SpawnResult = {
  pid:number|undefined; status:number|null; signal:NodeJS.Signals|null; stdout:string; stderr:string; error?:NodeJS.ErrnoException;
};

/**
 * spawnSync's result without blocking the process. A host worker waiting in spawnSync cannot take the daemon's next
 * call or its cancel: a 30 s call queued behind a two-minute check missed its deadline and the daemon SIGKILLed the
 * worker, the check with it (OVH, 2026-10-05: 15 times; every SelfyStudio «main is red» that day was that kill).
 * Like spawnSync: a time limit or an overfull stream (`maxBuffer`, per stream) sends SIGTERM and sets `error.code`
 * ETIMEDOUT / ENOBUFS; a failed launch sets `error` with no status.
 */
export function spawnAsync(file:string,args:readonly string[],options:{cwd?:string;env?:NodeJS.ProcessEnv;timeout?:number;maxBuffer?:number}={}):Promise<SpawnResult> {
  return new Promise((resolve)=>{
    const maxBuffer=options.maxBuffer??1024*1024;
    const out:Buffer[]=[]; const err:Buffer[]=[]; const size={out:0,err:0};
    let error:NodeJS.ErrnoException|undefined;
    let settled=false;
    let timer:NodeJS.Timeout|null=null;
    let grace:NodeJS.Timeout|null=null;
    const finish=(status:number|null,signal:NodeJS.Signals|null)=>{
      if(settled) return;
      settled=true;
      if(timer) clearTimeout(timer);
      if(grace) clearTimeout(grace);
      resolve({pid:child.pid,status,signal,stdout:Buffer.concat(out).toString("utf8"),stderr:Buffer.concat(err).toString("utf8"),...(error?{error}:{})});
    };
    const child=spawn(file,[...args],{cwd:options.cwd,env:options.env,stdio:["ignore","pipe","pipe"],windowsHide:true});
    const stop=(code:string)=>{
      error??=Object.assign(new Error(`spawn ${file} ${code}`),{code});
      child.kill("SIGTERM");
    };
    if(options.timeout) timer=setTimeout(()=>stop("ETIMEDOUT"),options.timeout);
    const take=(chunks:Buffer[],key:"out"|"err")=>(chunk:Buffer)=>{
      size[key]+=chunk.length;
      if(size[key]>maxBuffer) return stop("ENOBUFS");
      chunks.push(chunk);
    };
    child.stdout!.on("data",take(out,"out"));
    child.stderr!.on("data",take(err,"err"));
    child.on("error",(cause)=>{
      error??=cause;
      if(child.pid===undefined) finish(null,null);
    });
    child.on("close",(status,signal)=>finish(status,signal));
    // A background process the command started may hold its pipes open after it exits: don't wait for them.
    child.on("exit",(status,signal)=>{ grace=setTimeout(()=>finish(status,signal),2_000); });
  });
}
