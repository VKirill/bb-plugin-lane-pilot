import { roleDisplayName, t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import { ProgressBar } from "@lane-pilot/ui-kit";
import type { ConsoleOverviewOutput, GoalLine } from "../../../contracts/ui";

export type OverviewDays = 1 | 7 | 30;

const CLOSED_SERIES = [
  { key: "accepted", labelKey: "consoleOverviewOutcomeAccepted", fill: "var(--lp-success)" },
  { key: "reworked", labelKey: "consoleOverviewOutcomeReworked", fill: "var(--lp-warning)" },
  { key: "canceled", labelKey: "consoleOverviewOutcomeCanceled", fill: "var(--muted-foreground)" },
  { key: "failed", labelKey: "consoleOverviewOutcomeFailed", fill: "var(--destructive)" },
] as const;

export function safeTimeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return t("consoleOverviewLoadError");
}

export function formatUsd(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `$${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatElapsed(since: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - since) / 60_000);
  if (mins < 1) return t("consoleOverviewElapsedJustNow");
  if (mins < 60) return t("consoleOverviewElapsedMin").replace("{n}", String(mins));
  if (mins < 24 * 60) return t("consoleOverviewElapsedHour").replace("{n}", String(Math.floor(mins / 60)));
  return t("consoleOverviewElapsedDay").replace("{n}", String(Math.floor(mins / (24 * 60))));
}

export function stageLabel(stage: string | null): string {
  if (!stage) return "—";
  const key = `stage_${stage.replace(/-/g, "_")}` as I18nKey;
  const translated = t(key);
  return !translated || translated === key ? stage : translated;
}

function dayKeyInTz(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatDayTick(day: string, tz: string, locale: string, compact: boolean): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  // Use noon UTC so calendar dates stay on the same day across standard timezones.
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    ...(compact ? { day: "numeric", month: "numeric" } : { weekday: "short" }),
  }).format(new Date(noonUtc));
}

export function formatUpcomingTime(at: number, now: number, tz: string, locale: string): string {
  const sameDay = dayKeyInTz(at, tz) === dayKeyInTz(now, tz);
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

/** Stacked bar chart for closed task outcomes per day in the owner's timezone (frame "Closed chart"). */
export function ClosedByDayChart({
  rows,
  tz,
  locale,
  days,
}: {
  rows: ConsoleOverviewOutput["closedByDay"];
  tz: string;
  locale: string;
  days: OverviewDays;
}) {
  const totalOf = (row: ConsoleOverviewOutput["closedByDay"][number]) =>
    row.accepted + row.reworked + row.canceled + row.failed;
  const maxTotal = Math.max(1, ...rows.map(totalOf));

  return (
    <div className="space-y-3" data-testid="overview-closed-chart">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("consoleOverviewClosedEmpty")}</p>
      ) : (
        <div className="lpv-bars" data-dense={rows.length > 14 ? "1" : undefined} role="img" aria-label={t("consoleOverviewClosedChartTitle")}>
          {rows.map((row) => (
            <div
              key={row.day}
              className="lpv-bar-day"
              data-testid={`overview-chart-bar-${row.day}`}
              data-total={totalOf(row)}
              title={`${row.day}: ${CLOSED_SERIES.map((s) => `${t(s.labelKey)} ${row[s.key]}`).join(", ")}`}
            >
              <div className="lpv-bar-stack">
                {CLOSED_SERIES.map((series) =>
                  row[series.key] > 0 ? (
                    <span
                      key={series.key}
                      data-series={series.key}
                      style={{ height: `${Math.max(3, (row[series.key] / maxTotal) * 100)}%`, backgroundColor: series.fill }}
                    />
                  ) : null,
                )}
              </div>
              <span className="lpv-bar-tick">{formatDayTick(row.day, tz, locale, days === 30)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-[var(--lp-body)]">
        {CLOSED_SERIES.map((series) => (
          <span key={series.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-[9px] rounded-xs" style={{ backgroundColor: series.fill }} />
            {t(series.labelKey)}
          </span>
        ))}
      </div>
    </div>
  );
}

function formatDueDate(due: string, locale: string): string {
  const ms = Date.parse(`${due}T00:00:00Z`);
  if (!Number.isFinite(ms)) return due;
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(ms));
}

/** Progress row for a specialist charter goal, clickable to open that staff member's page. */
export function GoalRow({
  goal,
  projectName,
  locale,
  onOpen,
}: {
  goal: GoalLine;
  projectName: string;
  locale: Locale;
  onOpen: () => void;
}) {
  const pct =
    goal.current !== null && goal.target !== null && goal.target > 0
      ? Math.max(0, Math.min(100, Math.round((goal.current / goal.target) * 100)))
      : null;
  const toneText =
    goal.onTrack === true
      ? "lp-text-success"
      : goal.onTrack === false
        ? "lp-text-warning"
        : "text-muted-foreground";
  const progressText =
    goal.current !== null && goal.target !== null
      ? t("consoleOverviewGoalsProgress")
          .replace("{current}", goal.current.toLocaleString(locale))
          .replace("{target}", goal.target.toLocaleString(locale))
      : goal.metric;

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`overview-goal-${goal.projectId}-${goal.domain}`}
      className="-mx-2 flex w-[calc(100%+1rem)] min-w-0 flex-col gap-1.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="flex min-w-0 items-center justify-between gap-2 text-[12.5px]">
        <span className="min-w-0 truncate font-medium text-[var(--lp-ink)]">
          {roleDisplayName(goal.domain, locale)}
          {projectName ? ` · ${projectName}` : ""}
        </span>
        <span className={`shrink-0 font-semibold tabular-nums ${toneText}`}>
          {pct !== null
            ? `${pct}%`
            : goal.onTrack === true
              ? t("consoleOverviewGoalOnTrack")
              : goal.onTrack === false
                ? t("consoleOverviewGoalBehind")
                : "—"}
        </span>
      </div>
      <ProgressBar value={pct ?? 0} tone={goal.onTrack === true ? "ok" : goal.onTrack === false ? "warn" : "muted"} />
      <p className="min-w-0 text-[11.5px] text-[var(--lp-muted)]">
        {progressText}
        {goal.due ? ` ${t("consoleOverviewGoalsDue").replace("{due}", formatDueDate(goal.due, locale))}` : ""}
      </p>
    </button>
  );
}
