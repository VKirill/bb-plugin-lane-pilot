import { bestEffort } from "@lane-pilot/kit";

/** Runs the work it is given one after another, in the order it was given; a failure does not stop the queue. */

/** Runs the work it is given one after another, in the order it was given; a failure does not stop the queue. */
export function createSerialQueue():<T>(work:()=>Promise<T>)=>Promise<T> {
  let tail:Promise<unknown>=Promise.resolve();
  return <T>(work:()=>Promise<T>):Promise<T>=>{
    const turn=tail.then(work);
    tail=bestEffort(console.warn, "serial queue step", turn, undefined);
    return turn;
  };
}
