import type { ActiveItem, ConsoleOverviewOutput, GoalLine } from "../../../contracts";
import {
  listAttemptProjectIdsSince,
  listRunIdsForSection,
  listTaskIdsForRun,
  listTaskOutcomeRowsSince,
  type LanePilotDatabase,
} from "../../../storage";
import { attemptMetrics } from "../../../usage/server";
import { classifyOutcome } from "../../models/task-outcome";
import { buildTaskBoard } from "./task-board";

const DAY_MS = 86_400_000;

export interface MoneyStatusLike {
  costState?: string;
  todayUsd?: number;
  table?: ReadonlyArray<{ day: string; usd: number }>;
  series?: ReadonlyArray<{ day: string; usd: number }>;
}

export interface SpecialistCharterLike {
  projectId?: string;
  domain: string;
  updatedAt: number;
  metric?: string | null;
  current?: number | null;
  target?: number | null;
  due?: string | null;
}

export interface SpecialistOverviewLike {
  charters: ReadonlyArray<SpecialistCharterLike>;
}

export interface OwnerWaitingLike {
  items: ReadonlyArray<{ projectId: string | null; tier: "now" | "later" }>;
}

export interface ConsoleOverviewDeps {
  db: LanePilotDatabase;
  money: { status(): MoneyStatusLike };
  specialistOverview: (db: LanePilotDatabase, projectId?: string, nowMs?: number) => SpecialistOverviewLike;
  collectOwnerWaiting?: (db: LanePilotDatabase, now: number) => OwnerWaitingLike;
  tz: string;
  now?: () => number;
  log?: { warn?: (message: string) => void; debug?: (message: string) => void };
}

export interface ConsoleOverviewInput {
  projectId?: string;
  sectionId?: string;
  days?: 1 | 7 | 30;
}

function makeDayFormatter(tz: string): { tz: string; format: (ms: number) => string } {
  let effectiveTz = tz || "UTC";
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-GB", { timeZone: effectiveTz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    effectiveTz = "UTC";
    fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  return {
    tz: effectiveTz,
    format: (ms: number) => {
      const parts = fmt.formatToParts(new Date(ms));
      const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
      return `${get("year")}-${get("month")}-${get("day")}`;
    },
  };
}

function windowDayKeys(todayKey: string, days: number): string[] {
  const [y, m, d] = todayKey.split("-").map(Number);
  if (!y || !m || !d) return [todayKey];
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  }
  return keys;
}

function elapsedShare(due: string, startMs: number, nowMs: number): number | null {
  const dueMs = Date.parse(due);
  if (!Number.isFinite(dueMs)) return null;
  if (nowMs >= dueMs) return 1;
  if (!Number.isFinite(startMs) || startMs >= dueMs) return 0;
  if (nowMs <= startMs) return 0;
  return Math.max(0, Math.min(1, (nowMs - startMs) / (dueMs - startMs)));
}

function extractTodaySpendUsd(raw: unknown, utcToday: string, localToday: string): number | null {
  if (!raw || typeof raw !== "object") return null;
  const status = raw as Record<string, unknown>;
  if (typeof status.todayUsd === "number" && Number.isFinite(status.todayUsd)) return status.todayUsd;
  const rows = Array.isArray(status.table) ? status.table : Array.isArray(status.series) ? status.series : null;
  if (!rows) return null;
  const entry =
    rows.find((row) => row && typeof row === "object" && (row as { day?: unknown }).day === utcToday) ??
    rows.find((row) => row && typeof row === "object" && (row as { day?: unknown }).day === localToday);
  if (!entry || typeof entry !== "object") return null;
  const usd = (entry as { usd?: unknown }).usd;
  if (typeof usd !== "number" || !Number.isFinite(usd)) return null;
  if (status.costState === "not_measured" && usd === 0) return null;
  return usd;
}

function runPart<T>(
  name: string,
  fallback: T,
  log: ConsoleOverviewDeps["log"],
  fn: () => T,
): T {
  try {
    return fn();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log?.warn?.(`[console] overview part=${name} failed: ${message}`);
    return fallback;
  }
}

/**
 * Read model for the Overview screen (`console_overview`): aggregates active work, closed-by-day outcomes,
 * owner waiting count, today's spend, specialist goal progress, and attempt cost coverage.
 * Each source is isolated so a failing subsystem degrades only its own field.
 */
export function consoleOverview(deps: ConsoleOverviewDeps, input: ConsoleOverviewInput = {}): ConsoleOverviewOutput {
  const started = Date.now();
  const nowMs = deps.now ? deps.now() : started;
  const days = input.days ?? 7;
  const { tz, format: dayOf } = makeDayFormatter(deps.tz);
  const todayKey = dayOf(nowMs);
  const utcToday = new Date(nowMs).toISOString().slice(0, 10);

  const sectionRunIds = input.sectionId
    ? runPart("sectionRuns", [] as string[], deps.log, () =>
        listRunIdsForSection(deps.db, { projectId: input.projectId ?? null, sectionId: input.sectionId! }),
      )
    : null;
  const sectionTaskIds =
    sectionRunIds && sectionRunIds.length > 0
      ? new Set(sectionRunIds.flatMap((runId) => listTaskIdsForRun(deps.db, runId)))
      : sectionRunIds
        ? new Set<string>()
        : null;

  const active = runPart<ActiveItem[]>("active", [], deps.log, () => {
    if (sectionRunIds && sectionRunIds.length === 0) return [];
    const board = buildTaskBoard(deps.db, {
      projectId: input.projectId ?? null,
      doneSince: nowMs,
      limit: 50,
      ...(sectionRunIds ? { runIds: sectionRunIds, linkedRunIds: sectionRunIds } : {}),
    });
    return board
      .filter((item) => item.column !== "done")
      .map((item) => {
        let costUsd: number | null = null;
        if (item.kind === "task" && item.taskId && item.projectId) {
          try {
            const metrics = attemptMetrics(deps.db, { projectId: item.projectId, days: 7, now: nowMs, taskId: item.taskId });
            const priced = metrics.attempts.filter((attempt) => attempt.costUsd !== null);
            if (priced.length > 0) {
              costUsd = priced.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0);
            }
          } catch {
            costUsd = null;
          }
        }
        return {
          kind: item.kind,
          key: item.key,
          title: item.title,
          projectId: item.projectId,
          stage: item.stage,
          since: item.since ?? item.updatedAt,
          costUsd,
          runId: item.runId,
          taskId: item.taskId,
          pmThreadId: item.pmThreadId,
        };
      });
  });

  const closedByDay = runPart<ConsoleOverviewOutput["closedByDay"]>("closedByDay", [], deps.log, () => {
    const buckets = new Map<string, ConsoleOverviewOutput["closedByDay"][number]>();
    for (const key of windowDayKeys(todayKey, days)) {
      buckets.set(key, { day: key, accepted: 0, reworked: 0, canceled: 0, failed: 0 });
    }
    const sinceMs = nowMs - days * DAY_MS;
    const rows = listTaskOutcomeRowsSince(deps.db, {
      projectId: input.projectId ?? null,
      sectionId: input.sectionId ?? null,
      sinceMs,
    });
    for (const row of rows) {
      const outcome = classifyOutcome({ finalState: row.finalState, attemptCount: row.attemptCount });
      if (!outcome) continue;
      const day = dayOf(row.finishedAt);
      const bucket = buckets.get(day) ?? { day, accepted: 0, reworked: 0, canceled: 0, failed: 0 };
      bucket[outcome] += 1;
      buckets.set(day, bucket);
    }
    return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
  });

  const closedTodayRow = closedByDay.find((row) => row.day === todayKey);
  const closedToday = closedTodayRow
    ? closedTodayRow.accepted + closedTodayRow.reworked + closedTodayRow.canceled + closedTodayRow.failed
    : 0;

  const waiting = runPart<number>("waiting", 0, deps.log, () => {
    if (!deps.collectOwnerWaiting) return 0;
    const res = deps.collectOwnerWaiting(deps.db, nowMs);
    const filtered = input.projectId ? res.items.filter((item) => item.projectId === input.projectId) : res.items;
    return filtered.filter((item) => item.tier === "now" || item.tier === "later").length;
  });

  const spendTodayUsd = runPart<number | null>("spend", null, deps.log, () =>
    extractTodaySpendUsd(deps.money.status(), utcToday, todayKey),
  );

  const goals = runPart<GoalLine[]>("goals", [], deps.log, () => {
    const ov = deps.specialistOverview(deps.db, input.projectId, nowMs);
    return (ov.charters ?? []).map((rawCharter) => {
      const charter = rawCharter as {
        projectId?: string;
        domain: string;
        updatedAt: number;
        metric?: string | null;
        current?: number | null;
        target?: number | null;
        due?: string | null;
      };
      const current = typeof charter.current === "number" && Number.isFinite(charter.current) ? charter.current : null;
      const target = typeof charter.target === "number" && Number.isFinite(charter.target) ? charter.target : null;
      const due = typeof charter.due === "string" && charter.due.trim() ? charter.due.trim() : null;
      let onTrack: boolean | null = null;
      if (current !== null && target !== null && target > 0 && due !== null) {
        const elapsed = elapsedShare(due, charter.updatedAt, nowMs);
        if (elapsed !== null) onTrack = current / target >= elapsed;
      }
      return {
        projectId: charter.projectId ?? input.projectId ?? "",
        domain: charter.domain,
        metric: charter.metric ?? charter.domain,
        current,
        target,
        due,
        onTrack,
      };
    });
  });

  const costCoverage = runPart<number>("costCoverage", 1, deps.log, () => {
    if (sectionTaskIds && sectionTaskIds.size === 0) return 1;
    const sinceMs = nowMs - days * DAY_MS;
    const projectIds = input.projectId ? [input.projectId] : listAttemptProjectIdsSince(deps.db, sinceMs);
    let totalAttempts = 0;
    let measuredAttempts = 0;
    for (const pid of projectIds) {
      const report = attemptMetrics(deps.db, { projectId: pid, days, now: nowMs });
      if (sectionTaskIds) {
        const scoped = report.attempts.filter((attempt) => sectionTaskIds.has(attempt.taskId));
        totalAttempts += scoped.length;
        measuredAttempts += scoped.filter((attempt) => attempt.costState === "measured").length;
      } else {
        totalAttempts += report.summary.attempts;
        measuredAttempts += report.summary.measured;
      }
    }
    if (totalAttempts === 0) return 1;
    return Math.max(0, Math.min(1, measuredAttempts / totalAttempts));
  });

  const ms = Math.max(0, Date.now() - started);
  deps.log?.debug?.(`[console] overview project=${input.projectId ?? "all"} days=${days} active=${active.length} ms=${ms}`);

  return {
    tz,
    counts: {
      active: active.length,
      waiting,
      closedToday,
      spendTodayUsd,
      goalsOnTrack: goals.filter((goal) => goal.onTrack === true).length,
      goalsTotal: goals.length,
    },
    active,
    closedByDay,
    goals,
    costCoverage,
  };
}
