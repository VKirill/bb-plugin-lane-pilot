/**
 * Writer threads whose checks Lane Pilot runs now or holds in their run's check pool. Such an attempt stays «running» while
 * its writer is idle by design: Vampirism Fire on 2026-10-24 waited up to 50 minutes behind other tasks' Studio tests in a
 * pool of two, and the watcher took each wait for a stuck attempt. Kept in memory: a reload ends the checks with it, and an
 * attempt left «running» after that waits for nothing.
 */
const threads = new Map<string, { pool: string; count: number }>();
/** When a check of the pool last started or ended: a pool that stopped moving is stuck, the wait behind it is not. */
const poolMovedAt = new Map<string, number>();

/** The thread's checks begin waiting in `pool`; the returned call ends them. */
export function beginChecks(threadId: string, pool: string, now = Date.now()): () => void {
  const entry = threads.get(threadId);
  if (entry) entry.count += 1;
  else threads.set(threadId, { pool, count: 1 });
  if (!poolMovedAt.has(pool)) poolMovedAt.set(pool, now);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const current = threads.get(threadId);
    if (!current) return;
    if (current.count <= 1) threads.delete(threadId);
    else current.count -= 1;
  };
}

/** A check of the pool started or ended. */
export function checksMoved(pool: string, now = Date.now()): void {
  poolMovedAt.set(pool, now);
}

/** The thread's checks in flight and when their pool last moved; null when it has none. */
export function checksInFlight(threadId: string): { pool: string; movedAt: number } | null {
  const entry = threads.get(threadId);
  if (!entry) return null;
  return { pool: entry.pool, movedAt: poolMovedAt.get(entry.pool) ?? 0 };
}
