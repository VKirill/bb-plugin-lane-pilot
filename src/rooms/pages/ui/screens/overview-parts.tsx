import { roleDisplayName, t, type I18nKey, type Locale } from "@lane-pilot/i18n";
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

/** Stacked SVG bar chart for closed task outcomes per day in the owner's timezone. */
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
  const maxTotal = Math.max(
    1,
    ...rows.map((row) => row.accepted + row.reworked + row.canceled + row.failed),
  );
  const svgWidth = Math.max(280, rows.length * 40 + 24);
  const barAreaTop = 8;
  const barAreaHeight = 116;
  const labelY = barAreaTop + barAreaHeight + 16;
  const svgHeight = labelY + 8;
  const slotWidth = (svgWidth - 24) / Math.max(1, rows.length);
  const barWidth = Math.min(28, Math.max(8, Math.floor(slotWidth * 0.56)));

  return (
    <div className="space-y-3" data-testid="overview-closed-chart">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("consoleOverviewClosedEmpty")}</p>
      ) : (
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="h-40 w-full overflow-visible"
          role="img"
          aria-label={t("consoleOverviewClosedChartTitle")}
        >
          <line
            x1={8}
            x2={svgWidth - 8}
            y1={barAreaTop + barAreaHeight}
            y2={barAreaTop + barAreaHeight}
            stroke="var(--lp-hairline)"
            strokeWidth={1}
          />
          {rows.map((row, index) => {
            const x = 12 + index * slotWidth + (slotWidth - barWidth) / 2;
            const total = row.accepted + row.reworked + row.canceled + row.failed;
            let cursorY = barAreaTop + barAreaHeight;
            const segments = CLOSED_SERIES.map((series) => {
              const count = row[series.key];
              if (count <= 0) return null;
              const h = Math.max(3, Math.round((count / maxTotal) * barAreaHeight));
              cursorY -= h;
              return (
                <rect
                  key={series.key}
                  x={x}
                  y={cursorY}
                  width={barWidth}
                  height={h}
                  rx={2}
                  fill={series.fill}
                  data-series={series.key}
                />
              );
            });
            return (
              <g key={row.day} data-testid={`overview-chart-bar-${row.day}`} data-total={total}>
                <title>
                  {`${row.day}: ${CLOSED_SERIES.map((s) => `${t(s.labelKey)} ${row[s.key]}`).join(", ")}`}
                </title>
                {segments}
                <text
                  x={x + barWidth / 2}
                  y={labelY}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  fontSize="11"
                >
                  {formatDayTick(row.day, tz, locale, days === 30)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {CLOSED_SERIES.map((series) => (
          <span key={series.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-xs"
              style={{ backgroundColor: series.fill }}
            />
            {t(series.labelKey)}
          </span>
        ))}
      </div>
    </div>
  );
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
  const barFill =
    goal.onTrack === true
      ? "bg-[var(--lp-success)]"
      : goal.onTrack === false
        ? "bg-[var(--lp-warning)]"
        : "bg-muted-foreground";
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
      className="flex w-full min-w-0 flex-col gap-1.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate font-medium text-foreground">
          {roleDisplayName(goal.domain, locale)}
          {projectName ? ` · ${projectName}` : ""}
        </span>
        <span className={`shrink-0 font-medium tabular-nums ${toneText}`}>
          {pct !== null
            ? `${pct}%`
            : goal.onTrack === true
              ? t("consoleOverviewGoalOnTrack")
              : goal.onTrack === false
                ? t("consoleOverviewGoalBehind")
                : "—"}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--lp-well)]">
        <div
          className={`h-full rounded-full ${barFill}`}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{progressText}</span>
        {goal.due ? (
          <span className="shrink-0">
            {t("consoleOverviewGoalsDue").replace("{due}", goal.due)}
          </span>
        ) : null}
      </div>
    </button>
  );
}
