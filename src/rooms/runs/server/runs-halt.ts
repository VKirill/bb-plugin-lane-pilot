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

/**
 * A pause (runs-pause.ts) is the gentle sibling of a halt: nothing is canceled, nothing new starts, and a resume lets it go on.
 * The flag sits beside the halt flag so the parked-task restarts check both through one import.
 */
export const pausedRunKey = (runId: string) => `run-paused:${runId}`;

export async function runPausedSince(kv: Kv, runId: string): Promise<number | null> {
  const stored = await kv.get(pausedRunKey(runId)).catch(() => null) as { at?: unknown } | null;
  return stored && typeof stored.at === "number" ? stored.at : null;
}

export async function isRunPaused(kv: Kv, runId: string): Promise<boolean> {
  return (await runPausedSince(kv, runId)) !== null;
}

export async function setRunPaused(kv: Kv, runId: string, paused: boolean): Promise<void> {
  if (paused) { if (!await isRunPaused(kv, runId)) await kv.set(pausedRunKey(runId), { at: Date.now() }); }
  else if (await isRunPaused(kv, runId)) await kv.set(pausedRunKey(runId), null);
}

