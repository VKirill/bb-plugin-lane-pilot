/**
 * One overall budget of writer attempts per task, kept across starts, reloads, parked redrives and the writer chain.
 * Each of those had its own count in memory (the free retries of one start, the chain of one loop, the redrives of one
 * sweep), so a task that kept failing a new way was started again after every reload or fix and never ended. Every
 * fresh writer the task gets spends one unit; feedback turns in the same writer's thread and an attempt resumed on its
 * thread after a reload do not (they are the same attempt). The record lives in the plugin's key-value store.
 */
export const TASK_ATTEMPT_BUDGET = 12;
export const RETRY_BUDGET_PREFIX = "retry-budget:";
export const retryBudgetKey = (runId:string, taskId:string) => `${RETRY_BUDGET_PREFIX}${runId}:${taskId}`;

export type RetryBudgetKind = "attempt" | "fallback";
export type RetryBudgetRecord = { spent:number; attempts:number; fallbacks:number; firstAt:number; lastAt:number };
type Kv = { get(key:string):Promise<unknown>; set(key:string, value:never):Promise<unknown> };

const clean = (value:unknown):RetryBudgetRecord => {
  const row = (value && typeof value === "object" ? value : {}) as Partial<RetryBudgetRecord>;
  const number = (item:unknown) => typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : 0;
  return { spent:number(row.spent), attempts:number(row.attempts), fallbacks:number(row.fallbacks), firstAt:number(row.firstAt), lastAt:number(row.lastAt) };
};

/** The reason a task ends with once the budget is spent; the failure class reads the prefix as «budget» (not parked, not redriven). */
export const retryBudgetReason = (taskId:string, record:RetryBudgetRecord, limit = TASK_ATTEMPT_BUDGET) =>
  `retry_budget_exhausted: ${taskId} spent ${record.spent} of ${limit} writer attempts (${record.attempts} on the primary writer, ${record.fallbacks} on the fallback chain) across reloads and restarts; `
  + "read the failures, fix the plan or the contract, and dispatch it again as a new task";

export async function loadRetryBudget(kv:Pick<Kv, "get">, runId:string, taskId:string):Promise<RetryBudgetRecord> {
  return clean(await kv.get(retryBudgetKey(runId, taskId)).catch(() => null));
}

/**
 * Spends one unit before a fresh writer starts. `ok` is false when the budget was already spent: nothing is written then,
 * and the caller ends the task with `retryBudgetReason`. A store that cannot be read or written never stops a task.
 */
export async function spendRetryBudget(kv:Kv, runId:string, taskId:string, kind:RetryBudgetKind, now = Date.now(), limit = TASK_ATTEMPT_BUDGET):
  Promise<{ ok:boolean; record:RetryBudgetRecord }> {
  const record = await loadRetryBudget(kv, runId, taskId);
  if (record.spent >= limit) return { ok:false, record };
  const next:RetryBudgetRecord = { spent:record.spent + 1, attempts:record.attempts + (kind === "attempt" ? 1 : 0),
    fallbacks:record.fallbacks + (kind === "fallback" ? 1 : 0), firstAt:record.firstAt || now, lastAt:now };
  await kv.set(retryBudgetKey(runId, taskId), next as never).catch(() => undefined);
  return { ok:true, record:next };
}
