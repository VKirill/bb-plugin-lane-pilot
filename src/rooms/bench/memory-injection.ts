/**
 * arXiv #18 («Are memory modules worth their tokens»): the token-matched injection audit. Two arms over the same
 * manifest — one injects project memory, the other spends nothing on it — and the acceptance delta is priced per
 * 1k injected tokens. The runner already passes `settings` through to the sandbox project (runner.ts), so the arm is
 * only the pair of overrides below.
 */
export const MEMORY_INJECTION_ARMS = {
  on: { "memory.enabled": true, "memory.inject": true, "memory.maintain": false },
  off: { "memory.enabled": false, "memory.inject": false, "memory.maintain": false },
} as const;

type Db = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };

/** Estimated tokens of `dispatchContext.memoryText` a run's attempts were given (bytes / 4, the store's own unit). */
export function injectedTokensOf(db: Db, lpRunId: string): number {
  const rows = db.prepare(`SELECT t.trace_json AS trace FROM lane_pilot_attempt a
    LEFT JOIN lane_pilot_attempt_reasoning t ON t.attempt_id=a.id WHERE a.run_id=?`).all(lpRunId) as Array<{ trace: string | null }>;
  let tokens = 0;
  for (const row of rows) {
    try {
      const text = (JSON.parse(row.trace ?? "null") as { dispatchContext?: { memoryText?: string } } | null)?.dispatchContext?.memoryText;
      if (text) tokens += Math.ceil(Buffer.byteLength(text, "utf8") / 4);
    } catch { /* a broken trace is not evidence of injection */ }
  }
  return tokens;
}

/** Accepted share delta of the on-arm over the off-arm, priced per 1k injected tokens; null when either arm is empty. */
export function acceptancePerInjectedToken(on: ReadonlyArray<{ accepted: boolean }>, off: ReadonlyArray<{ accepted: boolean }>, injectedTokens: number): { delta: number; perKiloToken: number | null } {
  if (!on.length || !off.length) return { delta: 0, perKiloToken: null };
  const rate = (rows: ReadonlyArray<{ accepted: boolean }>) => rows.filter((row) => row.accepted).length / rows.length;
  const delta = rate(on) - rate(off);
  return { delta, perKiloToken: injectedTokens > 0 ? delta / (injectedTokens / 1000) : null };
}
