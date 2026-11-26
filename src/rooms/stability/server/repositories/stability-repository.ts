import { PARKED_KEY, type ParkedTask } from "../../../contracts";
import { readParkedTasks } from "../../../storage";
import { BREAKERS_KEY } from "../../models/stability";

export const REDRIVES_KEY = "stability:redrives";

export type KvStore = Parameters<typeof readParkedTasks>[0];

export type RedriveMemo = Record<string, { redrives: number; since?: number; at: number }>;

export async function loadParkedList(kv: KvStore): Promise<ParkedTask[]> {
  return readParkedTasks(kv);
}

export async function saveParkedList(kv: KvStore, list: ParkedTask[]): Promise<void> {
  await kv.set(PARKED_KEY, list);
}

export async function loadRedriveMemo(kv: KvStore): Promise<RedriveMemo> {
  const stored = await kv.get(REDRIVES_KEY);
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored as RedriveMemo : {};
}

export async function saveRedriveMemo(kv: KvStore, memo: RedriveMemo): Promise<void> {
  await kv.set(REDRIVES_KEY, memo);
}

export async function loadBreakersStore(kv: KvStore): Promise<unknown> {
  return kv.get(BREAKERS_KEY);
}

export async function saveBreakersStore(kv: KvStore, data: Record<string, unknown>): Promise<void> {
  await kv.set(BREAKERS_KEY, data);
}
