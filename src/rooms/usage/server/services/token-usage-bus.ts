const usageAddedListeners = new WeakMap<object, Set<() => void>>();

/** Subscribe to folded token-usage increments on `bb` (used by event-driven usage snapshot push). */
export function onTokenUsageAdded(bb: object, listener: () => void): () => void {
  let set = usageAddedListeners.get(bb);
  if (!set) { set = new Set(); usageAddedListeners.set(bb, set); }
  set.add(listener);
  return () => { set!.delete(listener); };
}

export function emitTokenUsageAdded(bb: object): void {
  const set = usageAddedListeners.get(bb);
  if (!set?.size) return;
  for (const listener of [...set]) {
    try { listener(); } catch { /* observers must not break token-usage folding */ }
  }
}
