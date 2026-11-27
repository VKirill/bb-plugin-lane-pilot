import { t, type Locale } from "@lane-pilot/i18n";
import { Button, PageHeader, StatusPill, Surface, SurfaceBody } from "@lane-pilot/ui-kit";
import type { SpecialistDetailOutput } from "../../contracts/ui";
import type { ExtractedCharterSummary, StaffScheduleItem } from "./staff-page-helpers";

/** Empty state shown when `staffRef` matches no charter, schedule, or known specialist role in the project. */
export function StaffUnknownState({
  projectName,
  domain,
  onBack,
}: {
  projectName: string;
  domain: string;
  onBack: () => void;
}) {
  return (
    <Surface testId="staff-unknown">
      <SurfaceBody className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground">{t("consoleStaffUnknownTitle")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("consoleStaffUnknownBody")
              .replace("{project}", projectName)
              .replace("{domain}", domain)}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="staff-back-to-list"
          onClick={onBack}
        >
          {t("consoleStaffBackToList")}
        </Button>
      </SurfaceBody>
    </Surface>
  );
}

/** Header for the employee detail screen (P4): breadcrumb, goal summary, on-track pill, and shift/pause/chat actions. */
export function StaffPageHeader({
  roleName,
  projectName,
  domain,
  locale,
  detail,
  summary,
  matchingSchedules,
  activeSchedulesCount,
  hasTickSchedule,
  runBusy,
  hasThread,
  onBack,
  onRunNow,
  onPause,
  onOpenChat,
}: {
  roleName: string;
  projectName: string;
  domain: string;
  locale: Locale;
  detail: SpecialistDetailOutput | undefined;
  summary: ExtractedCharterSummary;
  matchingSchedules: ReadonlyArray<StaffScheduleItem>;
  activeSchedulesCount: number;
  hasTickSchedule: boolean;
  runBusy: boolean;
  hasThread: boolean;
  onBack: () => void;
  onRunNow: () => void;
  onPause: () => void;
  onOpenChat: () => void;
}) {
  const allPaused = matchingSchedules.length > 0 && activeSchedulesCount === 0;
  const statusTone =
    detail?.loopHealth?.status === "failing"
      ? "bad"
      : allPaused
        ? "muted"
        : summary.onTrack === true
          ? "ok"
          : summary.onTrack === false
            ? "warn"
            : "muted";
  const statusLabel =
    detail?.loopHealth?.status === "failing"
      ? t("consoleStaffBreakerOpen")
      : allPaused
        ? t("consoleStaffPausedPill")
        : summary.onTrack === true
          ? t("consoleOverviewGoalOnTrack")
          : summary.onTrack === false
            ? t("consoleOverviewGoalBehind")
            : t("consoleStaffGoalPending");

  const goalParts: string[] = [];
  if (summary.goal) goalParts.push(summary.goal);
  if (summary.current !== null || summary.target !== null) {
    goalParts.push(
      t("consoleStaffGoalTarget")
        .replace("{current}", summary.current !== null ? summary.current.toLocaleString(locale) : "—")
        .replace("{target}", summary.target !== null ? summary.target.toLocaleString(locale) : "—"),
    );
  }
  if (summary.due) goalParts.push(t("consoleOverviewGoalsDue").replace("{due}", summary.due));

  return (
    <>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <button
          type="button"
          className="hover:text-foreground hover:underline"
          data-testid="staff-back-to-list"
          onClick={onBack}
        >
          {t("consoleNavStaff")}
        </button>
        <span>/</span>
        <span className="text-foreground">{roleName}</span>
      </div>

      <PageHeader
        title={`${roleName} · ${projectName}`}
        subtitle={
          <span data-testid="staff-header-goal">
            {goalParts.length > 0 ? goalParts.join(" · ") : domain}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={statusTone}>
              <span data-testid="staff-header-status">{statusLabel}</span>
            </StatusPill>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!hasTickSchedule || runBusy}
              data-testid="staff-run-now"
              onClick={onRunNow}
            >
              {runBusy ? t("consoleStaffRunningNow") : t("consoleStaffRunNow")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={activeSchedulesCount === 0}
              data-testid="staff-pause-btn"
              onClick={onPause}
            >
              {t("consoleStaffPauseBtn")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!hasThread}
              data-testid="staff-open-chat"
              onClick={onOpenChat}
            >
              {t("consoleStaffOpenChat")}
            </Button>
          </div>
        }
      />
    </>
  );
}
