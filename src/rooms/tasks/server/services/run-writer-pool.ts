import { resolve } from "node:path";

/** Writers at once per run: 15 by default and at most since 2026-10-04 (the owner runs batches of 10-15 tasks). */
const MAX_POOL = 15;

export class RunWriterPool {
  private readonly active=new Map<string,number>();
  /** Waiters per pool, each with its queue priority (SMA: Queue priority): a higher one is served first, equal ones in arrival order. */
  private readonly waiting=new Map<string,Array<{ wake:()=>void; rank:number; seq:number }>>();
  /** Folder claims are deliberately separate from keyed seats: parent/child paths overlap even when their keys differ. */
  private readonly folders: Array<{ hostId:string; path:string; release:()=>void }> = [];
  private readonly folderWaiting: Array<{ hostId:string; path:string; wake:(release:()=>void)=>void; reject:(cause:Error)=>void; rank:number; seq:number; signal?:AbortSignal; onAbort?:()=>void }> = [];
  private seq=0;

  /** Idle pass (SMA dt_idle): every seat of one pool taken, so an acquire would wait. */
  busy(key:string,limit:number):boolean {
    return (this.active.get(key)??0) >= limit;
  }

  async acquire(runId:string,limit:number,rank=1):Promise<()=>void> {
    if(!Number.isInteger(limit)||limit<1||limit>MAX_POOL)throw new Error(`provider pool limit must be an integer from 1 to ${MAX_POOL}`);
    const count=this.active.get(runId)??0;
    if(count<limit)this.active.set(runId,count+1);
    else await new Promise<void>(resolve=>{
      const queue=this.waiting.get(runId)??[];
      queue.push({ wake:resolve, rank, seq:this.seq++ });
      queue.sort((a,b)=>b.rank-a.rank||a.seq-b.seq);
      this.waiting.set(runId,queue);
    });
    let released=false;
    return ()=>{
      if(released)return;released=true;
      const queue=this.waiting.get(runId);
      const next=queue?.shift();
      if(queue?.length===0)this.waiting.delete(runId);
      if(next)next.wake();
      else {
        const active=this.active.get(runId)??0;
        if(active<=1)this.active.delete(runId);else this.active.set(runId,active-1);
      }
    };
  }

  /**
   * One same-host folder claim.  A claim conflicts when either path contains the other, so sibling runs cannot
   * bootstrap Git while a live writer owns their parent/child folder.  Unrelated hosts/folders remain parallel.
   */
  async acquireFolder(hostId:string,path:string,rank=1,signal?:AbortSignal):Promise<()=>void> {
    const normalized=resolve(path).replace(/\\/g,"/").replace(/\/+$/g,"") || "/";
    if (signal?.aborted) throw new Error("folder admission aborted");
    if (this.folderAvailable(hostId,normalized)) return this.claimFolder(hostId,normalized);
    return await new Promise<() => void>((resolve,reject) => {
      const waiter={ hostId, path:normalized, wake:resolve, reject, rank, seq:this.seq++, signal, onAbort:undefined as (()=>void)|undefined };
      if (signal) {
        waiter.onAbort=()=>{ const index=this.folderWaiting.indexOf(waiter); if (index>=0) this.folderWaiting.splice(index,1); reject(new Error("folder admission aborted")); };
        signal.addEventListener("abort",waiter.onAbort,{ once:true });
      }
      this.folderWaiting.push(waiter);
      this.folderWaiting.sort((a,b)=>b.rank-a.rank||a.seq-b.seq);
      this.drainFolderWaiters();
    });
  }

  private folderAvailable(hostId:string,path:string):boolean {
    return !this.folders.some((claim) => claim.hostId===hostId && folderOverlap(claim.path,path));
  }

  private claimFolder(hostId:string,path:string):()=>void {
    let released=false;
    const release=()=>{
      if (released) return;
      released=true;
      const index=this.folders.findIndex((claim)=>claim.release===release);
      if (index>=0) this.folders.splice(index,1);
      this.drainFolderWaiters();
    };
    this.folders.push({ hostId, path, release });
    return release;
  }

  private drainFolderWaiters():void {
    let granted=true;
    while (granted) {
      granted=false;
      const index=this.folderWaiting.findIndex((waiter)=>this.folderAvailable(waiter.hostId,waiter.path));
      if (index<0) return;
      const waiter=this.folderWaiting.splice(index,1)[0]!;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort",waiter.onAbort);
      waiter.wake(this.claimFolder(waiter.hostId,waiter.path));
      granted=true;
    }
  }
}

function folderOverlap(left:string,right:string):boolean {
  return left===right || left==="/" || right==="/" || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
