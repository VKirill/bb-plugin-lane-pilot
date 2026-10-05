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

/** Attempt / spawn reason prefix: `run_budget_exceeded:child threads`, `run_budget_exceeded:tokens`, … */
export function budgetStopReason(kind: BudgetKind): string {
  return `run_budget_exceeded:${LABEL[kind]}`;
}

/** Wall-clock and token overruns stop a running writer; child/attempt overruns refuse the next spawn instead. */
export function runningWriterBudgetStop(check: BudgetCheck): string | null {
  if (check.ok) return null;
  if (check.exceeded === "maxWallMs" || check.exceeded === "maxTokens") return budgetStopReason(check.exceeded);
  return null;
}

export class RunBudgetExceeded extends Error {
  readonly exceeded: BudgetKind;
  readonly used: number;
  readonly limit: number;
  constructor(check: Extract<BudgetCheck, { ok: false }>) {
    super(budgetStopReason(check.exceeded));
    this.name = "RunBudgetExceeded";
    this.exceeded = check.exceeded;
    this.used = check.used;
    this.limit = check.limit;
  }
}

export function createRunBudget(limits: RunBudgetLimits, startedAt = Date.now()) {
  let attempts = 0;
  let children = 0;
  const tokensByThread = new Map<string, number>();

  const tokens = () => [...tokensByThread.values()].reduce((sum, value) => sum + value, 0);

  function noteAttempt(): number { return ++attempts; }
  function noteChild(): number { return ++children; }
  /** Counts a new child if it would stay within `maxChildren`; otherwise leaves the count and fails the check. */
  function reserveChild(): BudgetCheck {
    const limit = limits.maxChildren;
    const used = children + 1;
    if (limit !== undefined && used > limit) {
      return { ok: false, exceeded: "maxChildren", used, limit, reason: `run budget exceeded: ${used} ${LABEL.maxChildren} > ${limit}` };
    }
    noteChild();
    return { ok: true };
  }
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

  return { noteAttempt, noteChild, reserveChild, noteTokens, check, snapshot };
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
