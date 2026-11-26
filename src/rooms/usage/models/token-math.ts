/**
 * The arithmetic of token usage: the breakdown of one usage record, the delta between two, what is billed, and the parse of a stored
 * breakdown. Pure and light on purpose: the attempt metrics, the forecast and the usage tab share it without the usage service's graph.
 */
export type TokenBreakdown = {
  input: number; output: number; cached: number; total: number; cacheRead: number; cacheWrite: number;
};

export const ZERO: TokenBreakdown = { input: 0, output: 0, cached: 0, total: 0, cacheRead: 0, cacheWrite: 0 };

export function tokenBreakdown(raw: unknown): TokenBreakdown {
  if (!raw || typeof raw !== "object") return { ...ZERO };
  const nMaybe = (key: string) => {
    const value = Reflect.get(raw, key);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
  };
  const cached = nMaybe("cachedInputTokens") ?? nMaybe("cacheReadInputTokens") ?? 0;
  const output = nMaybe("outputTokens") ?? 0;
  const total = nMaybe("totalTokens") ?? 0;
  const input = nMaybe("inputTokens") ?? 0;
  const cacheWrite = nMaybe("cacheWriteInputTokens") ?? 0;
  const cacheRead = nMaybe("cacheReadInputTokens") ?? cached;
  return { input, output, cached, total, cacheRead, cacheWrite };
}

export function hasTokens(row: TokenBreakdown): boolean {
  return row.total > 0 || row.input > 0 || row.output > 0 || row.cached > 0 || row.cacheRead > 0 || row.cacheWrite > 0;
}

export function sameTokens(a: TokenBreakdown, b: TokenBreakdown): boolean {
  return a.input === b.input && a.output === b.output && a.cached === b.cached && a.total === b.total
    && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

export function subTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cached: Math.max(0, a.cached - b.cached),
    total: Math.max(0, a.total - b.total),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  };
}

export function asBreakdown(row?: TokenBreakdown | null): TokenBreakdown {
  return { ...ZERO, ...row };
}

export function billedFrom(delta: TokenBreakdown): {
  uncached: number; cacheRead: number; cacheWrite: number; output: number; input: number; cached: number; total: number;
} {
  const cached = delta.cached > 0 ? delta.cached : delta.cacheRead + delta.cacheWrite;
  const uncached = Math.max(0, delta.total - delta.output - cached);
  const cacheRead = delta.cacheRead;
  const cacheWrite = delta.cacheWrite;
  const input = uncached + cacheRead + cacheWrite;
  const cachedOut = cacheRead + cacheWrite;
  const total = delta.total > 0 ? delta.total : input + delta.output;
  return { uncached, cacheRead, cacheWrite, output: delta.output, input, cached: cachedOut, total };
}

/**
 * Which providers report a cumulative `total` and keep few `thread/tokenUsage/updated` events (BB keeps one per Codex thread, the
 * latest): there `last` is only the final model call, so the thread's spend is the growth of `total`. Claude Code (and any provider
 * not listed) emits one event per turn, where `last` is the turn. Decided by provider id: the event shape cannot tell them apart.
 */
export function isCumulativeProvider(providerId: string): boolean {
  return providerId.toLowerCase().startsWith("codex");
}

/**
 * Per-turn delta from `last`; consecutive `total` only when last is missing or a re-emit. Never add cumulative totals.
 * `cumulative` (see `isCumulativeProvider`): delta = `total` minus the previous cumulative `total`; a `total` that went down (new session,
 * compaction) is a reset and counts as the new value, never a negative.
 */
export function tokenDelta(
  usage: { last?: TokenBreakdown | null; total?: TokenBreakdown | null },
  prev: { last: TokenBreakdown; total: TokenBreakdown; turnId: string },
  turnId = "",
  cumulative = false,
): TokenBreakdown {
  const last = asBreakdown(usage.last);
  const total = asBreakdown(usage.total);
  const prevLast = asBreakdown(prev.last);
  const prevTotal = asBreakdown(prev.total);
  if (cumulative && hasTokens(total)) {
    return !hasTokens(prevTotal) || total.total < prevTotal.total ? total : subTokens(total, prevTotal);
  }
  if (turnId && turnId === prev.turnId && hasTokens(last)) return subTokens(last, prevLast);
  if (hasTokens(last) && !sameTokens(last, prevLast)) return last;
  if (hasTokens(total) && hasTokens(prevTotal)) return subTokens(total, prevTotal);
  if (hasTokens(total) && !hasTokens(last) && !hasTokens(prevTotal)) return total;
  if (hasTokens(last)) return last;
  return { ...ZERO };
}

export function parseBreakdown(raw: string): TokenBreakdown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...ZERO };
    const n = (key: string) => {
      const value = Reflect.get(parsed, key);
      return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    };
    const stored = {
      input: n("input"), output: n("output"), cached: n("cached"), total: n("total"),
      cacheRead: n("cacheRead"), cacheWrite: n("cacheWrite"),
    };
    return hasTokens(stored) ? stored : tokenBreakdown(parsed);
  } catch { return { ...ZERO }; }
}
