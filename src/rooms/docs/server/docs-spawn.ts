import { stringAt, orMiss, isNotFound, bestEffort } from "@lane-pilot/kit";
import { sleepUntilThreadSignal, threadWatchMark } from "@lane-pilot/thread-observe";
import { fullAccessSpawn } from "../../platform/server";
import type { NightlyShared } from "./docs-night-state";

  /**
   * BB refuses to provision a thread on a checkout while another one is being provisioned there, so docs
   * agents are spawned one at a time: the next starts once the last has left "starting".
   */

  export function spawnDocsThread(n:NightlyShared,args:Parameters<NightlyShared["bb"]["sdk"]["threads"]["spawn"]>[0]):Promise<string>{
    const {bb}=n;

    const turn=n.docsSpawnGate.then(async()=>{
      // BB may still report another thread provisioning this checkout; that clears in seconds.
      let spawned:unknown;
      for(let attempt=0;;attempt++){
        try{ spawned=await fullAccessSpawn(bb, args); break; }
        catch(cause){
          if(attempt>=5||!/another thread is using this workspace/i.test(cause instanceof Error?cause.message:String(cause))) throw cause;
          await new Promise((done)=>setTimeout(done,5_000*(attempt+1)));
        }
      }
      const threadId=stringAt(spawned,"id"); if(!threadId) throw new Error("docs thread id missing");
      for(;;){
        const mark=threadWatchMark(bb);
        if(stringAt(await orMiss(bb.sdk.threads.get({threadId}), null, isNotFound),"status")!=="starting") break;
        await sleepUntilThreadSignal(bb,threadId,mark,2_000);
      }
      return threadId;
    });
    n.docsSpawnGate=bestEffort(bb.log, "docs spawn gate", turn, undefined);
    return turn;
  }
