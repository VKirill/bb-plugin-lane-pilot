import { CONVEYOR_KEY, type ConveyorState } from "../../models/conveyor";

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };

export async function conveyorState(kv: Kv): Promise<ConveyorState> {
  // A failed read must not report the conveyor on: propagating stops the caller instead of
  // silently restarting work the owner switched off.
  const stored = await kv.get(CONVEYOR_KEY) as { at?: number; reason?: string | null } | undefined;
  return stored?.at ? { on: false, since: new Date(stored.at).toISOString(), reason: stored.reason ?? null } : { on: true, since: null, reason: null };
}

export async function setConveyor(kv: Kv, on: boolean, reason?: string): Promise<ConveyorState> {
  if (on) await kv.set(CONVEYOR_KEY, null);
  else if ((await conveyorState(kv)).on) await kv.set(CONVEYOR_KEY, { at: Date.now(), reason: reason?.trim().slice(0, 300) || null });
  return await conveyorState(kv);
}
