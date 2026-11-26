import type { MemoryDatabase } from "./store";

export type MemoryRecordCommittedEvent = {
  projectId: string;
  personalBot: string;
  sourceSha256: string;
  insertedIds: readonly string[];
  origin: string;
  now: number;
};

export type MemoryCommitListener = (event: MemoryRecordCommittedEvent) => void;

const commitListeners = new WeakMap<object, Set<MemoryCommitListener>>();

/** Registers a listener invoked after `storeMemoryRecords` commits new or revived records on `db`. Returns an unsubscribe function. */
export function onMemoryRecordCommitted(db: MemoryDatabase, listener: MemoryCommitListener): () => void {
  let set = commitListeners.get(db);
  if (!set) {
    set = new Set();
    commitListeners.set(db, set);
  }
  set.add(listener);
  return () => { set?.delete(listener); };
}

/** Notifies listeners registered for `db` after a committed write. Listener errors are swallowed. */
export function notifyMemoryRecordCommitted(db: MemoryDatabase, event: MemoryRecordCommittedEvent): void {
  const listeners = commitListeners.get(db);
  if (!listeners?.size) return;
  for (const listener of listeners) {
    try { listener(event); } catch { /* listener errors must not fail a committed store write */ }
  }
}
