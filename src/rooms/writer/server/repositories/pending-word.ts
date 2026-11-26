type PendingWordKv = { get(key:string):Promise<unknown>; set(key:string, value:never):Promise<unknown>; delete(key:string):Promise<unknown> };

/** Kv key of the PM's words a running writer could not take mid-run; the next fresh-thread attempt reads them once. */
const pendingWordKey = (runId:string, taskId:string) => `lp.task.pending-word:${runId}:${taskId}`;

/** Keeps a word for the task's next attempt (sma as_redirect_deferred): appended, never overwritten. */
export async function pendingWordPush(kv:PendingWordKv, runId:string, taskId:string, line:string):Promise<void> {
  const key = pendingWordKey(runId, taskId);
  const kept = await kv.get(key);
  const list = Array.isArray(kept) ? kept.filter((row):row is string => typeof row === "string") : [];
  await kv.set(key, [...list, line.slice(0, 2000)].slice(-8) as never);
}

/** The kept words as one brief block, cleared on read so one word rides one attempt only. */
export async function pendingWordTake(kv:PendingWordKv, runId:string, taskId:string):Promise<string | null> {
  const key = pendingWordKey(runId, taskId);
  const kept = await kv.get(key);
  const list = Array.isArray(kept) ? kept.filter((row):row is string => typeof row === "string") : [];
  if (!list.length) return null;
  await kv.delete(key).catch(() => undefined);
  return `the PM corrected the task meanwhile:\n${list.map((line) => `- ${line}`).join("\n")}`;
}
