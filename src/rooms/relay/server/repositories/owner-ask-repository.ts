import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { clip } from "@lane-pilot/contracts";
import { bestEffort } from "@lane-pilot/kit";

export const PENDING_PREFIX = "owner-ask:pending:";
export type PendingRecord = { threadId: string; question: string; source: string; at: number };

export function recordPendingAsk(bb: BbPluginApi, log: (message: string) => void, threadId: string, question: string, source: string): Promise<void> {
  return bestEffort(
    log,
    "owner question pending record",
    Promise.resolve(bb.storage.kv.set(`${PENDING_PREFIX}${threadId}`, { threadId, question: clip(question, 300), source, at: Date.now() } satisfies PendingRecord as never)),
    undefined,
  );
}

export function clearPendingAsk(bb: BbPluginApi, log: (message: string) => void, key: string): Promise<void> {
  return bestEffort(log, "owner question pending clear", bb.storage.kv.delete(key), undefined);
}

export function clearPendingAskForThread(bb: BbPluginApi, log: (message: string) => void, threadId: string): Promise<void> {
  return clearPendingAsk(bb, log, `${PENDING_PREFIX}${threadId}`);
}

export async function hasPendingAsk(bb: BbPluginApi, threadId: string): Promise<boolean> {
  return Boolean(await bb.storage.kv.get(`${PENDING_PREFIX}${threadId}`));
}

export async function listPendingAskKeys(bb: BbPluginApi): Promise<string[]> {
  return bb.storage.kv.list(PENDING_PREFIX);
}

export async function readPendingAsk(bb: BbPluginApi, key: string): Promise<PendingRecord | undefined> {
  return bb.storage.kv.get<PendingRecord>(key);
}
