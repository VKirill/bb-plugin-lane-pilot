/**
 * The conveyor switch (SMA atlas D2-10: «Conveyor switch», «Conveyor off from the factory»): one flag for the whole plugin. Off, no new
 * work is issued anywhere — a task waits before it takes a writer slot exactly as in a paused run (`isHeld`, runs/server/runs-pause.ts), parked tasks are not restarted, the
 * night loop picks nothing — while running attempts finish their current stage and every check (run goal, capabilities, regression) goes
 * on. The flag lives in the plugin's key-value store, so a reload keeps it.
 */
export const CONVEYOR_KEY = "conveyor:off";
type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
export type ConveyorState = { on: boolean; since: string | null; reason: string | null };

export async function conveyorState(kv: Kv): Promise<ConveyorState> {
  const stored = await kv.get(CONVEYOR_KEY).catch(() => null) as { at?: number; reason?: string | null } | null;
  return stored?.at ? { on: false, since: new Date(stored.at).toISOString(), reason: stored.reason ?? null } : { on: true, since: null, reason: null };
}

export async function setConveyor(kv: Kv, on: boolean, reason?: string): Promise<ConveyorState> {
  if (on) await kv.set(CONVEYOR_KEY, null);
  else if ((await conveyorState(kv)).on) await kv.set(CONVEYOR_KEY, { at: Date.now(), reason: reason?.trim().slice(0, 300) || null });
  return await conveyorState(kv);
}
