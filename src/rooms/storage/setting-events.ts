import type { LanePilotDatabase } from "./database";

type SettingChangeListener = (projectId: string, keys: readonly string[]) => void;
const listeners = new WeakMap<object, Set<SettingChangeListener>>();

/** Observe committed setting writes/resets on `db` (used for event-driven usage snapshot pushes). */
export function onSettingChanged(db: LanePilotDatabase, listener: SettingChangeListener): () => void {
  let set = listeners.get(db);
  if (!set) { set = new Set(); listeners.set(db, set); }
  set.add(listener);
  return () => { set!.delete(listener); };
}

export function emitSettingChanged(db: LanePilotDatabase, projectId: string, keys: readonly string[]): void {
  const set = listeners.get(db);
  if (!set?.size || !keys.length) return;
  for (const listener of [...set]) {
    try { listener(projectId, keys); } catch { /* observers must not break settings persistence */ }
  }
}
