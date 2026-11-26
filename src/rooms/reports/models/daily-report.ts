import type { CostState } from "@lane-pilot/contracts";

/**
 * Pure formatting and schedule-due rules for the compact daily status digest.
 * Always stays within 8 lines and renders cost as "не измерено" (never 0) when cost facts are incomplete.
 */
const DEFAULT_DAILY_AT_HOUR = 9;

export const DAILY_SENT_KEY = "daily_sent_day";
export const DAILY_DRY_KEY = "daily_dry_day";

export type DailySummary = {
  day: string;
  accepted: number;
  failed: number;
  total: number;
  workflowRuns: number;
  workflowSucceeded: number;
  workflowFailed: number;
  costUsd: number | null;
  costState: CostState;
  measuredSteps: number;
  notMeasuredSteps: number;
  waitingOpen: number;
  waitingOverdue: number;
  deferralsOpen: number;
  deferralsOverdue: number;
  outages: number;
};

/** Formats local YYYY-MM-DD and 0-23 hour in `timezone`. */
export function localDayHour(now: number, timezone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return {
    day: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour") || 0) % 24,
  };
}

/** Returns whether today's daily digest is due at `atHour` in `timezone` and has not already been sent on that day. */
export function dailyDue(
  now: number,
  timezone: string,
  lastSentDay: string | null,
  atHour: number = DEFAULT_DAILY_AT_HOUR,
): { due: boolean; day: string } {
  const { day, hour } = localDayHour(now, timezone);
  return { due: hour >= atHour && lastSentDay !== day, day };
}

function formatCostLine(summary: Pick<DailySummary, "costUsd" | "costState" | "measuredSteps" | "notMeasuredSteps">): string {
  if (summary.costState === "not_measured" || summary.costUsd === null) {
    return "Расходы (24ч): не измерено";
  }
  if (summary.costState === "partial") {
    const totalSteps = summary.measuredSteps + summary.notMeasuredSteps;
    return `Расходы (24ч): $${summary.costUsd.toFixed(2)} (частично: ${summary.measuredSteps}/${totalSteps})`;
  }
  return `Расходы (24ч): $${summary.costUsd.toFixed(2)}`;
}

/** Composes the <= 8 line Telegram daily status digest from structured run, owner-waiting, deferral, and outage facts. */
export function composeDailyReport(summary: DailySummary): string {
  const lines: string[] = [
    `Lane Pilot · ${summary.day} (24ч)`,
    `Попытки: принято ${summary.accepted}, не прошло ${summary.failed} (всего ${summary.total})`,
    `Графы: запусков ${summary.workflowRuns} (успешно ${summary.workflowSucceeded}, сбой ${summary.workflowFailed})`,
    formatCostLine(summary),
    `Ждут владельца: ${summary.waitingOpen}${summary.waitingOverdue > 0 ? ` (просрочено ${summary.waitingOverdue})` : ""}`,
  ];
  if (summary.deferralsOpen > 0 || summary.deferralsOverdue > 0) {
    lines.push(
      `Отсрочки: открыто ${summary.deferralsOpen}${summary.deferralsOverdue > 0 ? `, просрочено ${summary.deferralsOverdue}` : ""}`,
    );
  }
  if (summary.outages > 0) {
    lines.push(`Простои: ${summary.outages}`);
  }
  return lines.slice(0, 8).join("\n");
}
