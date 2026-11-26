import {
  REVERT_INTENT_PREFIX, isValidRevertIntent, revertIntentKey,
  type RevertIntent, type RevertIntentKv, type RevertIntentRead,
} from "../../models";

const keyPart = (value: string) => encodeURIComponent(value);

/** Strictly persists an intent before a rollback can call the host. */
export async function writeRevertIntent(kv: RevertIntentKv, intent: RevertIntent): Promise<void> {
  if (!isValidRevertIntent(intent)) throw new Error("invalid revert intent");
  await kv.set(revertIntentKey(intent), intent);
}

/** Reads only one task's operation family. Malformed matching KV is an unknown effect, never an empty result. */
export async function readRevertIntents(kv: RevertIntentKv, runId: string, taskId: string): Promise<RevertIntentRead> {
  const prefix = `${REVERT_INTENT_PREFIX}${keyPart(runId)}:${keyPart(taskId)}:`;
  let keys: string[];
  try { keys = await kv.list(prefix); }
  catch (cause) { return { state: "unknown", reason: `revert intent list failed: ${cause instanceof Error ? cause.message : String(cause)}` }; }
  const intents: RevertIntent[] = [];
  for (const key of keys) {
    let value: unknown;
    try { value = await kv.get(key); }
    catch (cause) { return { state: "unknown", reason: `revert intent ${key} unreadable: ${cause instanceof Error ? cause.message : String(cause)}` }; }
    if (!isValidRevertIntent(value) || revertIntentKey(value) !== key || value.runId !== runId || value.taskId !== taskId) {
      return { state: "unknown", reason: `malformed revert intent ${key}` };
    }
    intents.push(value);
  }
  return intents.length ? { state: "pending", intent: intents.sort((a, b) => b.createdAt - a.createdAt)[0]! } : { state: "none" };
}

/** Deletes only the exact operation record that was read; operation ids are part of the key so a later rollback cannot be cleared. */
export async function clearRevertIntent(kv: RevertIntentKv, intent: RevertIntent): Promise<void> {
  const key = revertIntentKey(intent);
  const current = await kv.get(key);
  if (!isValidRevertIntent(current) || current.opId !== intent.opId || current.runId !== intent.runId || current.taskId !== intent.taskId) {
    throw new Error(`revert intent ${intent.opId} changed before clear`);
  }
  await kv.delete(key);
}
