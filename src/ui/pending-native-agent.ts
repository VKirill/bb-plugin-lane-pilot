type PendingNativeAgent = { agentId: string; description: string };

let pendingNativeAgent: PendingNativeAgent | null = null;
const pendingListeners = new Set<() => void>();

export function setPendingNativeAgent(next: PendingNativeAgent | null): void {
  pendingNativeAgent = next;
  for (const listener of pendingListeners) listener();
}

export function subscribePendingNativeAgent(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

export function getPendingNativeAgent(): PendingNativeAgent | null {
  return pendingNativeAgent;
}
