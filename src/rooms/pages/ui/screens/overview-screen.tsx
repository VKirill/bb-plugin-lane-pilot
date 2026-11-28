import { useCallback, useMemo, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { detectLocale, t, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  KpiTile,
  PageHeader,
  Segments,
  Skeleton,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  StatusPill,
  usePanelLayout,
} from "@lane-pilot/ui-kit";
import { LP_ALL_PROJECTS } from "@lane-pilot/ui-kit/realtime-channel";
import type { ActiveItem, ConsoleOverviewOutput } from "../../../contracts/ui";
import { useLpRealtime, useLpRpcQuery } from "../../../ui-shell/ui";
import type { ConsoleRoute } from "../../models/nav-model";
import {
  ClosedByDayChart,
  GoalRow,
  errorMessage,
  formatElapsed,
  formatUpcomingTime,
  formatUsd,
  safeTimeZone,
  stageLabel,
  type OverviewDays,
} from "./overview-parts";

type CalendarPlannedItem = { scheduleId: string; at: number };
type CalendarPayload = { planned: CalendarPlannedItem[]; past?: unknown[]; truncated?: string[] };

const CALENDAR_LOOKAHEAD_DAYS = 30;
const DAY_MS = 86_400_000;
/** The prototype frame shows four running tasks; the rest sit behind the toggle. */
const ACTIVE_COLLAPSED_ROWS = 4;

export interface OverviewScreenProps {
  projectId: string | null;
  sectionId: string | null;
  go: (next: ConsoleRoute) => void;
  projects?: ReadonlyArray<{ id: string; name: string }>;
  locale?: Locale;
}

/** Owner console Overview screen (P1): KPI tiles, active work table, closed-by-day chart, staff goals, and upcoming scheduled runs. */
export function OverviewScreen({ projectId, sectionId, go, projects = [], locale: localeProp }: OverviewScreenProps) {
  const locale = localeProp ?? detectLocale();
  const { stackControls } = usePanelLayout();
  const rpc = useRpc() as { call: (method: string, input: unknown) => Promise<unknown> };
  const navigate = useBbNavigate();
  const [days, setDays] = useState<OverviewDays>(7);

  const overviewInput = useMemo(
    () => ({
      ...(projectId ? { projectId } : {}),
      ...(sectionId ? { sectionId } : {}),
      days,
    }),
    [projectId, sectionId, days],
  );
  const overviewQuery = useLpRpcQuery<ConsoleOverviewOutput>("console_overview", overviewInput, {
    pollMs: 15_000,
  });

  useLpRealtime(projectId ?? LP_ALL_PROJECTS, ["helpers"], () => {
    void overviewQuery.refetch();
  });

  const fetchCalendar = useCallback(async () => {
    const from = Date.now();
    const to = from + CALENDAR_LOOKAHEAD_DAYS * DAY_MS;
    return (await rpc.call("schedule_calendar", {
      ...(projectId ? { projectId } : {}),
      from,
      to,
    })) as CalendarPayload;
  }, [rpc, projectId]);

  const calendarQuery = useLpRpcQuery<CalendarPayload>(
    null,
    { kind: "overview-calendar", projectId },
    { pollMs: 30_000, fetcher: fetchCalendar },
  );

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const resolveProject = (id: string | null) => (id ? projectNames.get(id) ?? id : "—");
  const scopedBase = {
    ...(projectId ? { projectId } : {}),
    ...(sectionId ? { sectionId } : {}),
  };

  const data = overviewQuery.data;
  const tz = safeTimeZone(data?.tz);
  const now = Date.now();
  const subtitleDate = new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(now));
  const scopeLabel = projectId ? resolveProject(projectId) : t("consoleAllProjects");

  const [showAllActive, setShowAllActive] = useState(false);
  const visibleActive = showAllActive ? data?.active ?? [] : (data?.active ?? []).slice(0, ACTIVE_COLLAPSED_ROWS);
  const hiddenActive = (data?.active.length ?? 0) - visibleActive.length;

  const upcomingRuns = useMemo(() => {
    const planned = calendarQuery.data?.planned ?? [];
    return [...planned].sort((a, b) => a.at - b.at).slice(0, 5);
  }, [calendarQuery.data]);

  const openActiveItem = (item: ActiveItem) => {
    if (item.kind === "task" && item.runId && item.taskId) {
      go({ ...scopedBase, section: "work", taskRef: { runId: item.runId, taskId: item.taskId } });
      return;
    }
    if (item.kind === "batch" && item.pmThreadId) {
      navigate?.toThread?.(item.pmThreadId);
      return;
    }
    go({ ...scopedBase, section: "work" });
  };

  const costCoverageNote =
    data && data.costCoverage < 1
      ? t("consoleOverviewCostCoverage").replace("{pct}", String(Math.round(data.costCoverage * 100)))
      : undefined;

  return (
    <div className="space-y-[18px]" data-testid="console-overview">
      <PageHeader
        title={t("consoleNavOverview")}
        subtitle={`${subtitleDate} · ${scopeLabel}`}
        actions={
          <Segments
            testId="overview-period"
            label={t("consoleOverviewPeriodLabel")}
            compact={stackControls}
            value={String(days)}
            onChange={(next) => setDays(Number(next) as OverviewDays)}
            items={[
              { id: "1", label: t("consoleOverviewPeriodToday") },
              { id: "7", label: t("consoleOverviewPeriod7d") },
              { id: "30", label: t("consoleOverviewPeriod30d") },
            ]}
          />
        }
      />

      {overviewQuery.error ? (
        <Alert variant="destructive" data-testid="overview-error">
          <AlertTitle>{t("consoleOverviewLoadError")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{errorMessage(overviewQuery.error)}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="overview-retry"
              onClick={() => void overviewQuery.refetch()}
            >
              {t("consoleOverviewRetry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!data && overviewQuery.isLoading ? (
        <div className="space-y-4" data-testid="overview-loading" aria-busy="true" aria-label={t("consoleOverviewLoading")}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-20 rounded-[14px]" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-[14px]" />
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-5" data-testid="overview-kpis">
            <KpiTile
              testId="kpi-active"
              label={t("consoleOverviewKpiActive")}
              value={data.counts.active}
              tone={data.counts.active > 0 ? "accent" : "muted"}
            />
            <KpiTile
              testId="kpi-waiting"
              label={t("consoleOverviewKpiWaiting")}
              value={data.counts.waiting}
              tone={data.counts.waiting > 0 ? "warn" : "muted"}
              onClick={() => go({ ...scopedBase, section: "decisions" })}
            />
            <KpiTile
              testId="kpi-closed-today"
              label={t("consoleOverviewKpiClosedToday")}
              value={data.counts.closedToday}
              tone={data.counts.closedToday > 0 ? "ok" : "muted"}
            />
            <KpiTile
              testId="kpi-spend-today"
              label={t("consoleOverviewKpiSpendToday")}
              value={formatUsd(data.counts.spendTodayUsd, locale)}
              note={costCoverageNote}
              tone="muted"
            />
            <KpiTile
              testId="kpi-goals"
              label={t("consoleOverviewKpiGoals")}
              value={t("consoleOverviewGoalsRatio")
                .replace("{onTrack}", String(data.counts.goalsOnTrack))
                .replace("{total}", String(data.counts.goalsTotal))}
              tone={
                data.counts.goalsTotal === 0
                  ? "muted"
                  : data.counts.goalsOnTrack === data.counts.goalsTotal
                    ? "ok"
                    : "warn"
              }
            />
          </div>

          <div className="lpv-body">
            <div className="min-w-0 space-y-[18px]">
              <Surface testId="overview-active" className="lpv-live">
                <SurfaceHeader className="justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={`size-2 rounded-full ${data.active.length > 0 ? "bg-[var(--lp-success)]" : "bg-muted-foreground"}`}
                    />
                    <h2 className="text-sm font-semibold text-[var(--lp-ink)]">{t("consoleOverviewActiveTitle")}</h2>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="lpv-link h-7 px-2 text-xs"
                    data-testid="overview-all-work"
                    onClick={() => go({ ...scopedBase, section: "work" })}
                  >
                    {t("consoleOverviewAllWork")}
                  </Button>
                </SurfaceHeader>
                <SurfaceBody>
                  {data.active.length === 0 ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="overview-active-empty">
                      <p className="text-sm text-muted-foreground">{t("consoleOverviewActiveEmpty")}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid="overview-empty-staff"
                          onClick={() => go({ ...scopedBase, section: "staff" })}
                        >
                          {t("consoleOverviewOpenStaff")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid="overview-empty-work"
                          onClick={() => go({ ...scopedBase, section: "work" })}
                        >
                          {t("consoleOverviewOpenWork")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <ul className="lpv-live-list" data-testid="overview-active-table">
                        {visibleActive.map((item) => (
                          <li key={item.key}>
                            <div
                              role="button"
                              tabIndex={0}
                              data-testid={`overview-active-row-${item.key}`}
                              className="lpv-live-row focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              onClick={() => openActiveItem(item)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  openActiveItem(item);
                                }
                              }}
                            >
                              <div className="lpv-live-what">
                                <span className="lpv-live-title">{item.title}</span>
                                <span className="lpv-live-who">{resolveProject(item.projectId)}</span>
                              </div>
                              <div className="lpv-live-stage">
                                {item.stage ? <StatusPill tone="accent">{stageLabel(item.stage)}</StatusPill> : null}
                              </div>
                              <div className="lpv-live-meta">
                                <span className="lpv-live-elapsed">{formatElapsed(item.since, now)}</span>
                                <span className="lpv-live-cost">{formatUsd(item.costUsd, locale)}</span>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {hiddenActive > 0 || showAllActive ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="lpv-link mt-1 h-7 px-0 text-xs"
                          data-testid="overview-active-toggle"
                          aria-expanded={showAllActive}
                          onClick={() => setShowAllActive((open) => !open)}
                        >
                          {showAllActive
                            ? t("consoleOverviewActiveCollapse")
                            : t("consoleOverviewActiveShowAll").replace("{n}", String(data.active.length))}
                        </Button>
                      ) : null}
                    </>
                  )}
                </SurfaceBody>
              </Surface>

              <Surface testId="overview-closed-by-day">
                <SurfaceHeader className="justify-between">
                  <h2 className="text-sm font-semibold text-[var(--lp-ink)]">{t("consoleOverviewClosedChartTitle")}</h2>
                </SurfaceHeader>
                <SurfaceBody>
                  <ClosedByDayChart rows={data.closedByDay} tz={tz} locale={locale} days={days} />
                </SurfaceBody>
              </Surface>
            </div>

            <div className="min-w-0 space-y-[18px]">
              <Surface testId="overview-goals">
                <SurfaceHeader>
                  <h2 className="text-sm font-semibold text-[var(--lp-ink)]">{t("consoleOverviewGoalsTitle")}</h2>
                </SurfaceHeader>
                <SurfaceBody className="space-y-3">
                  {data.goals.length === 0 ? (
                    <p className="text-xs text-muted-foreground" data-testid="overview-goals-empty">
                      {t("consoleOverviewGoalsEmpty")}
                    </p>
                  ) : (
                    data.goals.map((goal) => (
                      <GoalRow
                        key={`${goal.projectId}:${goal.domain}`}
                        goal={goal}
                        projectName={resolveProject(goal.projectId)}
                        locale={locale}
                        onOpen={() =>
                          go({
                            ...scopedBase,
                            section: "staff",
                            staffRef: { projectId: goal.projectId, domain: goal.domain },
                          })
                        }
                      />
                    ))
                  )}
                </SurfaceBody>
              </Surface>

              <Surface testId="overview-upcoming">
                <SurfaceHeader className="justify-between">
                  <h2 className="text-sm font-semibold text-[var(--lp-ink)]">{t("consoleOverviewUpcomingTitle")}</h2>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="lpv-link h-7 px-2 text-xs"
                    data-testid="overview-all-schedules"
                    onClick={() => go({ ...scopedBase, section: "system", page: "schedules" })}
                  >
                    {t("consoleSysSchedules")}
                  </Button>
                </SurfaceHeader>
                <SurfaceBody>
                  {calendarQuery.error ? (
                    <p className="text-xs text-destructive-text" data-testid="overview-upcoming-error">
                      {t("consoleOverviewUpcomingError")}
                    </p>
                  ) : upcomingRuns.length === 0 ? (
                    <p className="text-xs text-muted-foreground" data-testid="overview-upcoming-empty">
                      {t("consoleOverviewUpcomingEmpty")}
                    </p>
                  ) : (
                    <ul className="space-y-3" data-testid="overview-upcoming-list">
                      {upcomingRuns.map((run) => (
                        <li
                          key={`${run.scheduleId}:${run.at}`}
                          className="flex min-w-0 gap-3 text-[12.5px] leading-snug"
                          data-testid={`overview-upcoming-item-${run.scheduleId}`}
                        >
                          <span className="w-[62px] shrink-0 text-xs font-semibold tabular-nums text-[var(--lp-ink)]">
                            {formatUpcomingTime(run.at, now, tz, locale)}
                          </span>
                          <span className="min-w-0 flex-1 break-words text-[var(--lp-body)]">{run.scheduleId}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </SurfaceBody>
              </Surface>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
