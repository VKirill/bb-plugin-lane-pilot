/**
 * An owner's «stop everything in this run»: no parked task of the run restarts, nothing of it is parked again, no
 * repair task is dispatched for it, until the PM sends a new task there (2026-10-04, SelfyStudio's owner stopped a
 * run; parked restarts and the fallback chain would otherwise have started work again).
 */
export const haltedRunKey = (runId:string) => `run-halted:${runId}`;

type Kv = { get(key:string):Promise<unknown>; set(key:string, value:unknown):Promise<void> };

export async function isRunHalted(kv:Kv, runId:string):Promise<boolean> {
  return Boolean(await kv.get(haltedRunKey(runId)).catch(() => null));
}
export async function setRunHalted(kv:Kv, runId:string, halted:boolean):Promise<void> {
  if (halted) await kv.set(haltedRunKey(runId), { at:Date.now() });
  else if (await isRunHalted(kv, runId)) await kv.set(haltedRunKey(runId), null);
}
