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

let chatAgentVersion = 0;

/** An existing chat's agent was switched or cleared: the badge reads it again. */
export function noteChatAgentChanged(): void {
  chatAgentVersion += 1;
  for (const listener of pendingListeners) listener();
}

export function getChatAgentVersion(): number {
  return chatAgentVersion;
}

export function getPendingNativeAgent(): PendingNativeAgent | null {
  return pendingNativeAgent;
}
