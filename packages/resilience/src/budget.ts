export type RunBudgetLimits = {
  maxAttempts?: number;
  maxWallMs?: number;
  maxTokens?: number;
  maxChildren?: number;
};

export type BudgetKind = keyof RunBudgetLimits;

export type BudgetCheck =
  | { ok: true }
  | { ok: false; exceeded: BudgetKind; used: number; limit: number; reason: string };

export type RunBudgetSnapshot = { attempts: number; children: number; tokens: number; elapsedMs: number; limits: RunBudgetLimits };

const LABEL: Record<BudgetKind, string> = { maxAttempts: "attempts", maxWallMs: "wall-clock ms", maxTokens: "tokens", maxChildren: "child threads" };

export function createRunBudget(limits: RunBudgetLimits, startedAt = Date.now()) {
  let attempts = 0;
  let children = 0;
  const tokensByThread = new Map<string, number>();

  const tokens = () => [...tokensByThread.values()].reduce((sum, value) => sum + value, 0);

  function noteAttempt(): number { return ++attempts; }
  function noteChild(): number { return ++children; }
  /** BB reports a running total per thread; the run total is the sum of the latest per thread. */
  function noteTokens(threadId: string, total: number): number {
    if (Number.isFinite(total) && total >= 0) tokensByThread.set(threadId, Math.max(total, tokensByThread.get(threadId) ?? 0));
    return tokens();
  }

  function check(now = Date.now()): BudgetCheck {
    const used: Record<BudgetKind, number> = { maxAttempts: attempts, maxWallMs: now - startedAt, maxTokens: tokens(), maxChildren: children };
    for (const kind of ["maxAttempts", "maxWallMs", "maxTokens", "maxChildren"] as const) {
      const limit = limits[kind];
      if (limit !== undefined && used[kind] > limit) {
        return { ok: false, exceeded: kind, used: used[kind], limit, reason: `run budget exceeded: ${used[kind]} ${LABEL[kind]} > ${limit}` };
      }
    }
    return { ok: true };
  }

  function snapshot(now = Date.now()): RunBudgetSnapshot {
    return { attempts, children, tokens: tokens(), elapsedMs: now - startedAt, limits: { ...limits } };
  }

  return { noteAttempt, noteChild, noteTokens, check, snapshot };
}

export type RunBudget = ReturnType<typeof createRunBudget>;

/** Reads a BB `thread/tokenUsage/updated` event; other events yield null. */
export function tokenUsageFromEvent(event: unknown): { threadId: string; totalTokens: number } | null {
  if (!event || typeof event !== "object") return null;
  const type = Reflect.get(event, "type");
  const data = Reflect.get(event, "data") ?? event;
  if (type !== "thread/tokenUsage/updated" || !data || typeof data !== "object") return null;
  const threadId = Reflect.get(data, "threadId") ?? Reflect.get(event, "threadId");
  const usage = Reflect.get(data, "tokenUsage");
  const total = usage && typeof usage === "object" ? Reflect.get(usage, "total") : undefined;
  const totalTokens = total && typeof total === "object" ? Reflect.get(total, "totalTokens") : undefined;
  if (typeof threadId !== "string" || typeof totalTokens !== "number") return null;
  return { threadId, totalTokens };
}

const KEYS: Record<string, BudgetKind> = {
  "run.max_attempts": "maxAttempts",
  "run.max_wall_minutes": "maxWallMs",
  "run.max_tokens": "maxTokens",
  "run.max_children": "maxChildren",
};

/** Settings are strings or numbers; blank means no limit. Minutes are converted to milliseconds. */
export function parseRunBudgetLimits(raw: Record<string, unknown>): RunBudgetLimits {
  const limits: RunBudgetLimits = {};
  for (const [setting, kind] of Object.entries(KEYS)) {
    const value = raw[setting];
    if (value === undefined || value === null || value === "") continue;
    const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${setting} must be a positive integer`);
    limits[kind] = kind === "maxWallMs" ? n * 60_000 : n;
  }
  return limits;
}
