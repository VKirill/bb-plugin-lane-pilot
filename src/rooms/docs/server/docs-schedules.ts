import { abortable, scheduleIsolated } from "../../platform/server";
import { pluginStopped } from "./plugin-stopped";
import { runNightlyDocs, runDocsCatchUps } from "./docs-nightly-pass";
import { runScheduledDocsMaintenance } from "./docs-maintenance";
import type { NightlyShared } from "./docs-night-state";

  /**
   * BB runs every plugin's schedules one after another and waits for each, so a docs pass awaited in a schedule (hours)
   * stops all of them - self-repair included. The work runs detached; a tick while it still runs is skipped.
   */
  function guarded(n:NightlyShared,name:string,work:(signal?:AbortSignal)=>Promise<unknown>):(signal?:AbortSignal)=>Promise<void> {
    const {bb,schedulesRunning}=n;

    return async(signal?:AbortSignal)=>{
      if(schedulesRunning.has(name)) return;
      schedulesRunning.add(name);
      try{ await (signal?abortable(signal,Promise.resolve(work(signal))):work()); }
      catch(cause){ if(!pluginStopped(cause)) bb.log.warn(`Lane Pilot schedule ${name} failed: ${cause instanceof Error?cause.message:String(cause)}`); }
      finally{ schedulesRunning.delete(name); }
    };
  }
  /** Without the VK isolated schedules the pass runs beside the schedule, which returns at once. */
  function inBackground(n:NightlyShared,name:string,work:()=>Promise<unknown>):()=>Promise<void> {
    const {bb,schedulesRunning}=n;

    const run=guarded(n,name,work);
    return async()=>{ void run(); };
  }
  /** With them the core waits for the pass without holding other schedules, and aborts it after the limit. */
  function scheduleDocs(n:NightlyShared,name:string,cron:string,work:(signal?:AbortSignal)=>Promise<unknown>,timeoutMs:number){
    const {bb,schedulesRunning}=n;

    scheduleIsolated(bb,name,cron,guarded(n,name,work),{timeoutMs,fallback:inBackground(n,name,work)});
  }


/** The three docs schedules of a night: the hourly upkeep, the hourly pass, the catch-up tick every two minutes. */
export function registerDocsSchedules(n:NightlyShared):void {
    const {bb,schedulesRunning}=n;

  scheduleIsolated(bb,"docs-maintenance-hourly","0 * * * *",(signal?:AbortSignal)=>runScheduledDocsMaintenance(n,signal),{timeoutMs:3*3_600_000});

  scheduleDocs(n,"docs-nightly-hourly","0 * * * *",(signal)=>runNightlyDocs(n,{signal}),6*3_600_000);

  scheduleDocs(n,"docs-nightly-catchup","*/2 * * * *",(signal?:AbortSignal)=>runDocsCatchUps(n,signal),6*3_600_000);
}
