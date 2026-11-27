import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  StatusPill,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@lane-pilot/ui-kit";
import type { SpecialistDetailOutput } from "../../contracts/ui";
import {
  formatShiftTime,
  formatUsdAmount,
  shiftOutcomeTone,
  type ExtractedCharterSummary,
} from "./staff-page-helpers";

const CAP_PERIOD_KEYS: Readonly<Record<"day" | "month" | "test", I18nKey>> = {
  day: "consoleStaffCapPeriod_day",
  month: "consoleStaffCapPeriod_month",
  test: "consoleStaffCapPeriod_test",
};

/** Charter tab (P4): goal, metric, formula, data source, constraints, budgets, channels, version/approver, pending draft, and recent shifts preview. */
export function StaffCharterTab({
  detail,
  summary,
  locale,
  onEditCharter,
  onOpenShifts,
}: {
  detail: SpecialistDetailOutput;
  summary: ExtractedCharterSummary;
  locale: Locale;
  onEditCharter: () => void;
  onOpenShifts: () => void;
}) {
  const charter = detail.charter;

  if (!charter) {
    return (
      <Surface testId="staff-charter-empty">
        <SurfaceBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t("consoleStaffCharterEmpty")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="staff-charter-edit-btn"
            onClick={onEditCharter}
          >
            {t("consoleStaffCharterEditBtn")}
          </Button>
        </SurfaceBody>
      </Surface>
    );
  }

  const approvedDate = charter.approvedAt ? formatShiftTime(charter.approvedAt, locale) : null;
  const recentPreview = detail.shifts.recent.slice(0, 5);
  const currentText = summary.current !== null ? summary.current.toLocaleString(locale) : "—";
  const targetText = summary.target !== null ? summary.target.toLocaleString(locale) : "—";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" data-testid="staff-tab-charter">
      <div className="space-y-4">
        {charter.pendingDraft ? (
          <Alert data-testid="staff-charter-draft-banner">
            <AlertTitle>
              {t("consoleStaffCharterDraftTitle").replace("{id}", charter.pendingDraft.draftId)}
            </AlertTitle>
            <AlertDescription>{t("consoleStaffCharterDraftBody")}</AlertDescription>
          </Alert>
        ) : null}

        <Surface testId="staff-charter-goal-card">
          <SurfaceHeader className="justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("consoleStaffCharterGoalTitle")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="staff-charter-edit-btn"
              onClick={onEditCharter}
            >
              {t("consoleStaffCharterEditBtn")}
            </Button>
          </SurfaceHeader>
          <SurfaceBody className="space-y-3">
            {summary.goal ? (
              <p className="text-base font-semibold text-foreground" data-testid="staff-charter-goal-text">
                {summary.goal}
              </p>
            ) : null}
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-[var(--lp-well)]/60 p-2.5">
                <dt className="text-[11px] text-muted-foreground">{t("consoleStaffCharterMetric")}</dt>
                <dd className="mt-0.5 text-xs font-medium text-foreground" data-testid="staff-charter-metric">
                  {summary.metric ?? "—"}
                </dd>
              </div>
              <div className="rounded-lg bg-[var(--lp-well)]/60 p-2.5">
                <dt className="text-[11px] text-muted-foreground">
                  {t("consoleStaffGoalTarget").replace("{current}", currentText).replace("{target}", targetText)}
                </dt>
                <dd className="mt-0.5 text-xs font-medium tabular-nums text-foreground">
                  {currentText} → {targetText}
                </dd>
              </div>
              <div className="rounded-lg bg-[var(--lp-well)]/60 p-2.5">
                <dt className="text-[11px] text-muted-foreground">{t("consoleStaffCharterDue")}</dt>
                <dd className="mt-0.5 text-xs font-medium text-foreground">{summary.due ?? "—"}</dd>
              </div>
              <div className="rounded-lg bg-[var(--lp-well)]/60 p-2.5">
                <dt className="text-[11px] text-muted-foreground">{t("consoleStaffCharterDataSource")}</dt>
                <dd className="mt-0.5 text-xs font-medium text-foreground" data-testid="staff-charter-data-source">
                  {summary.dataSource ?? "—"}
                </dd>
              </div>
            </dl>
            <div className="rounded-lg bg-[var(--lp-well)]/40 p-2.5 text-xs">
              <span className="text-muted-foreground">{t("consoleStaffCharterFormula")}: </span>
              <span className="font-mono text-foreground" data-testid="staff-charter-formula">
                {summary.formula ?? "—"}
              </span>
            </div>
          </SurfaceBody>
        </Surface>

        <div className="grid gap-4 md:grid-cols-2">
          <Surface testId="staff-charter-constraints">
            <SurfaceHeader>
              <h3 className="text-sm font-semibold">{t("consoleStaffCharterConstraints")}</h3>
            </SurfaceHeader>
            <SurfaceBody>
              {summary.constraints.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("consoleStaffCharterConstraintsEmpty")}</p>
              ) : (
                <dl className="space-y-2 text-xs">
                  {summary.constraints.map((item) => (
                    <div key={item.key} className="flex items-baseline justify-between gap-2">
                      <dt className="text-muted-foreground">{item.label}</dt>
                      <dd className="text-right font-medium text-foreground">{item.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </SurfaceBody>
          </Surface>

          <Surface testId="staff-charter-budgets">
            <SurfaceHeader>
              <h3 className="text-sm font-semibold">{t("consoleStaffCharterBudgets")}</h3>
            </SurfaceHeader>
            <SurfaceBody className="space-y-2">
              {summary.budgets.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("consoleStaffCharterBudgetsEmpty")}</p>
              ) : (
                <dl className="space-y-2 text-xs">
                  {summary.budgets.map((item) => (
                    <div key={item.key} className="flex items-baseline justify-between gap-2">
                      <dt className="text-muted-foreground">{item.label}</dt>
                      <dd className="font-medium tabular-nums text-foreground">{item.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <p className="pt-1 text-[11px] text-muted-foreground">{t("consoleStaffCharterBudgetsHint")}</p>
            </SurfaceBody>
          </Surface>
        </div>

        <Surface testId="staff-charter-channels">
          <SurfaceHeader>
            <h3 className="text-sm font-semibold">{t("consoleStaffCharterChannels")}</h3>
          </SurfaceHeader>
          <SurfaceBody className="space-y-2">
            {summary.channels.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("consoleStaffCharterChannelsEmpty")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {summary.channels.map((ch) => (
                  <Badge key={ch} variant="secondary" className="text-xs">
                    {ch}
                  </Badge>
                ))}
              </div>
            )}
            {summary.emergencyNote ? (
              <p className="text-xs text-muted-foreground">{summary.emergencyNote}</p>
            ) : null}
          </SurfaceBody>
        </Surface>

        <p className="text-xs text-muted-foreground" data-testid="staff-charter-version">
          {t("consoleStaffCharterVersion").replace("{v}", String(charter.version))}
          {charter.approvedBy
            ? ` · ${t("consoleStaffCharterApprovedBy").replace("{by}", charter.approvedBy)}`
            : ""}
          {approvedDate
            ? ` · ${t("consoleStaffCharterApprovedAt").replace("{date}", approvedDate)}`
            : ""}
        </p>
      </div>

      <Surface testId="staff-charter-shifts-preview" className="h-fit">
        <SurfaceHeader className="justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("consoleStaffCharterRecentShifts")}</h3>
          <Button type="button" size="sm" variant="ghost" onClick={onOpenShifts}>
            {t("consoleStaffCharterAllShifts")}
          </Button>
        </SurfaceHeader>
        <SurfaceBody>
          {recentPreview.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("consoleStaffShiftsNone")}</p>
          ) : (
            <ul className="space-y-2.5 text-xs">
              {recentPreview.map((shift, idx) => (
                <li key={`${shift.at}-${idx}`} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">{shift.depth}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatShiftTime(shift.at, locale)}
                      {shift.workflowId ? ` · ${shift.workflowId}` : ""}
                    </div>
                  </div>
                  <StatusPill tone={shiftOutcomeTone(shift.outcome)} className="shrink-0">
                    {shift.outcome}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </SurfaceBody>
      </Surface>
    </div>
  );
}

/** Shifts tab (P4): last/next shift cards and recent shift history with graph and run links. */
export function StaffShiftsTab({
  shifts,
  locale,
  onOpenGraph,
  onOpenRun,
}: {
  shifts: SpecialistDetailOutput["shifts"];
  locale: Locale;
  onOpenGraph: (workflowId: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <div className="space-y-4" data-testid="staff-tab-shifts">
      <div className="grid gap-4 md:grid-cols-2">
        <Surface testId="staff-shifts-last">
          <SurfaceHeader>
            <h3 className="text-sm font-semibold">{t("consoleStaffShiftsLast")}</h3>
          </SurfaceHeader>
          <SurfaceBody className="flex flex-wrap items-center justify-between gap-2 text-xs">
            {shifts.last ? (
              <>
                <div className="space-y-0.5">
                  <div className="font-medium text-foreground">{shifts.last.depth}</div>
                  <div className="text-muted-foreground">{formatShiftTime(shifts.last.at, locale)}</div>
                </div>
                <StatusPill tone={shiftOutcomeTone(shifts.last.outcome)}>{shifts.last.outcome}</StatusPill>
              </>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </SurfaceBody>
        </Surface>

        <Surface testId="staff-shifts-next">
          <SurfaceHeader>
            <h3 className="text-sm font-semibold">{t("consoleStaffShiftsNext")}</h3>
          </SurfaceHeader>
          <SurfaceBody className="text-xs">
            {shifts.next ? (
              <div className="space-y-0.5">
                <div className="font-medium text-foreground">{shifts.next.depth}</div>
                <div className="text-muted-foreground">{formatShiftTime(shifts.next.at, locale)}</div>
              </div>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </SurfaceBody>
        </Surface>
      </div>

      <Surface testId="staff-shifts-list">
        <SurfaceHeader>
          <h3 className="text-sm font-semibold">{t("consoleStaffCharterRecentShifts")}</h3>
        </SurfaceHeader>
        <SurfaceBody>
          {shifts.recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("consoleStaffShiftsNone")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("consoleStaffShiftsColTime")}</TableHead>
                  <TableHead>{t("consoleStaffShiftsColDepth")}</TableHead>
                  <TableHead>{t("consoleStaffShiftsColOutcome")}</TableHead>
                  <TableHead>{t("consoleStaffShiftsColGraph")}</TableHead>
                  <TableHead>{t("consoleStaffShiftsColRun")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shifts.recent.map((shift, idx) => (
                  <TableRow key={`${shift.at}-${idx}`} data-testid={`staff-shift-row-${idx}`}>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatShiftTime(shift.at, locale)}
                    </TableCell>
                    <TableCell className="text-xs font-medium">{shift.depth}</TableCell>
                    <TableCell>
                      <StatusPill tone={shiftOutcomeTone(shift.outcome)}>{shift.outcome}</StatusPill>
                    </TableCell>
                    <TableCell>
                      {shift.workflowId ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="link"
                          className="h-auto p-0 text-xs"
                          data-testid={`staff-shift-graph-${idx}`}
                          onClick={() => onOpenGraph(shift.workflowId!)}
                        >
                          {shift.workflowId}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {shift.runId ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="link"
                          className="h-auto p-0 text-xs"
                          data-testid={`staff-shift-run-${idx}`}
                          onClick={() => onOpenRun(shift.runId!)}
                        >
                          {t("consoleStaffShiftsOpenRun")}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SurfaceBody>
      </Surface>
    </div>
  );
}

/** Costs tab (P4): day/month/test spend caps with used vs cap bars. */
export function StaffCostsTab({
  caps,
  locale,
}: {
  caps: SpecialistDetailOutput["caps"];
  locale: Locale;
}) {
  return (
    <Surface testId="staff-tab-costs">
      <SurfaceHeader>
        <h3 className="text-sm font-semibold">{t("consoleStaffCostsTitle")}</h3>
      </SurfaceHeader>
      <SurfaceBody>
        {caps.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("consoleStaffCostsEmpty")}</p>
        ) : (
          <div className="space-y-4">
            {caps.map((cap) => {
              const pct =
                cap.capUsd !== null && cap.capUsd > 0
                  ? Math.max(0, Math.min(100, Math.round((cap.usedUsd / cap.capUsd) * 100)))
                  : 0;
              const barColor =
                cap.capUsd !== null && cap.capUsd > 0 && cap.usedUsd >= cap.capUsd
                  ? "bg-[var(--lp-danger)]"
                  : pct >= 80
                    ? "bg-[var(--lp-warning)]"
                    : "bg-[var(--lp-success)]";

              return (
                <div key={cap.period} className="space-y-1.5" data-testid={`staff-cap-${cap.period}`}>
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-medium text-foreground">{t(CAP_PERIOD_KEYS[cap.period])}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatUsdAmount(cap.usedUsd, locale)} /{" "}
                      {cap.capUsd !== null ? formatUsdAmount(cap.capUsd, locale) : t("consoleStaffCapNoLimit")}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--lp-well)]">
                    <div
                      className={`h-full rounded-full ${barColor}`}
                      style={{ width: `${pct}%` }}
                      data-testid={`staff-cap-bar-${cap.period}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SurfaceBody>
    </Surface>
  );
}
