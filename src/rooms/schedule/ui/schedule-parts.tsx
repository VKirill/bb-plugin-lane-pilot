import { t, type I18nKey } from "@lane-pilot/i18n";
import type { RunView, ScheduleView } from "../views";
import { cronWords } from "./schedule-model";

/** Small pieces the board, the history and the calendar share. */

export const fmtTime = (at: number): string => new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
export const fmtClock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { timeStyle: "short" });
export const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
export const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), text);

const PILL: Record<RunView["status"], string> = {
  queued: "lp-pill-muted", running: "lp-pill-info", waiting: "lp-pill-warning", succeeded: "lp-pill-success",
  failed: "lp-pill-danger", timed_out: "lp-pill-danger", skipped: "lp-pill-muted", canceled: "lp-pill-muted",
};

export function RunPill({ status, testId }: { status: RunView["status"]; testId?: string }) {
  return <span className={`${PILL[status]} shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium`} data-testid={testId}>{t(`schRunStatus_${status}` as I18nKey)}</span>;
}

/** «Every weekday at 9:00» for the shapes people say; the raw cron and zone otherwise; the moment for a one-time task. */
export function whenText(when: ScheduleView["when"]): string {
  if (when.type === "once") return fill(t("schWhenOnce"), { time: fmtTime(when.runAt) });
  const words = cronWords(when.cron);
  const tz = when.timezone;
  if (!words) return fill(t("schWhenCron"), { cron: when.cron, tz });
  const text = words.kind === "daily" ? fill(t("schCronDaily"), { time: words.time })
    : words.kind === "weekdays" ? fill(t("schCronWeekdays"), { time: words.time })
      : words.kind === "hourly" ? fill(t("schCronHourly"), { minute: words.minute })
        : fill(t("schCronMonthly"), { day: words.day, time: words.time });
  return `${text} · ${tz}`;
}
