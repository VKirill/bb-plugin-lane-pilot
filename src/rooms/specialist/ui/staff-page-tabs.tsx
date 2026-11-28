import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ProgressBar,
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

const SHIFT_DOT_COLOR = {
  ok: "var(--lp-ok)",
  bad: "var(--lp-bad)",
  accent: "var(--lp-accent)",
  muted: "var(--lp-muted)",
} as const;

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
    <div className="grid gap-[22px] lg:grid-cols-[minmax(0,1fr)_340px]" data-testid="staff-tab-charter">
      <div className="min-w-0 space-y-3.5">
        {charter.pendingDraft ? (
          <Alert data-testid="staff-charter-draft-banner">
            <AlertTitle>
              {t("consoleStaffCharterDraftTitle").replace("{id}", charter.pendingDraft.draftId)}
            </AlertTitle>
            <AlertDescription>{t("consoleStaffCharterDraftBody")}</AlertDescription>
          </Alert>
        ) : null}

        <Surface testId="staff-charter-goal-card" className="space-y-3.5 border-[var(--lp-accent)] p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.5px] text-[var(--lp-accent)]">
              {t("consoleStaffCharterGoalTitle")}
            </span>
            <button
              type="button"
              className="text-[12.5px] font-semibold text-[var(--lp-accent)] hover:underline"
              data-testid="staff-charter-edit-btn"
              onClick={onEditCharter}
            >
              {t("consoleStaffCharterEditBtn")}
            </button>
          </div>
          {summary.goal ? (
            <p
              className="text-xl font-semibold leading-[1.4] text-[var(--lp-ink)]"
              data-testid="staff-charter-goal-text"
            >
              {summary.goal}
            </p>
          ) : null}
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lp-field">
              <dt>{t("consoleStaffCharterMetric")}</dt>
              <dd data-testid="staff-charter-metric">{summary.metric ?? "—"}</dd>
            </div>
            <div className="lp-field">
              <dt>{t("consoleStaffGoalTarget").replace("{current}", currentText).replace("{target}", targetText)}</dt>
              <dd className="tabular-nums">
                {currentText} → {targetText}
              </dd>
            </div>
            <div className="lp-field">
              <dt>{t("consoleStaffCharterDue")}</dt>
              <dd>{summary.due ?? "—"}</dd>
            </div>
            <div className="lp-field">
              <dt>{t("consoleStaffCharterDataSource")}</dt>
              <dd data-testid="staff-charter-data-source">{summary.dataSource ?? "—"}</dd>
            </div>
          </dl>
          <div className="lp-field">
            <dt>{t("consoleStaffCharterFormula")}</dt>
            <dd className="font-mono text-xs" data-testid="staff-charter-formula">
              {summary.formula ?? "—"}
            </dd>
          </div>
        </Surface>

        <div className="grid items-start gap-3.5 md:grid-cols-2">
          <Surface testId="staff-charter-constraints" className="space-y-2.5 p-[18px]">
            <h3 className="text-[13.5px] font-semibold text-[var(--lp-ink)]">{t("consoleStaffCharterConstraints")}</h3>
            {summary.constraints.length === 0 ? (
              <p className="text-xs text-[var(--lp-muted)]">{t("consoleStaffCharterConstraintsEmpty")}</p>
            ) : (
              <dl>
                {summary.constraints.map((item) => (
                  <div key={item.key} className="lp-kv">
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Surface>

          <Surface testId="staff-charter-budgets" className="space-y-2.5 p-[18px]">
            <h3 className="text-[13.5px] font-semibold text-[var(--lp-ink)]">{t("consoleStaffCharterBudgets")}</h3>
            {summary.budgets.length === 0 ? (
              <p className="text-xs text-[var(--lp-muted)]">{t("consoleStaffCharterBudgetsEmpty")}</p>
            ) : (
              <dl>
                {summary.budgets.map((item) => (
                  <div key={item.key} className="lp-kv">
                    <dt>{item.label}</dt>
                    <dd className="tabular-nums">{item.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="text-[11.5px] leading-[1.4] text-[var(--lp-muted)]">{t("consoleStaffCharterBudgetsHint")}</p>
          </Surface>
        </div>

        <Surface testId="staff-charter-channels" className="space-y-2.5 p-[18px]">
          <h3 className="text-[13.5px] font-semibold text-[var(--lp-ink)]">{t("consoleStaffCharterChannels")}</h3>
          {summary.channels.length === 0 ? (
            <p className="text-xs text-[var(--lp-muted)]">{t("consoleStaffCharterChannelsEmpty")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {summary.channels.map((ch) => (
                <span key={ch} className="lp-tag">
                  {ch}
                </span>
              ))}
            </div>
          )}
          {summary.emergencyNote ? (
            <p className="text-xs leading-[1.4] text-[var(--lp-body)]">{summary.emergencyNote}</p>
          ) : null}
        </Surface>

        <p className="text-xs text-[var(--lp-muted)]" data-testid="staff-charter-version">
          {t("consoleStaffCharterVersion").replace("{v}", String(charter.version))}
          {charter.approvedBy
            ? ` · ${t("consoleStaffCharterApprovedBy").replace("{by}", charter.approvedBy)}`
            : ""}
          {approvedDate
            ? ` · ${t("consoleStaffCharterApprovedAt").replace("{date}", approvedDate)}`
            : ""}
        </p>
      </div>

      <Surface testId="staff-charter-shifts-preview" className="h-fit space-y-3.5 p-[18px]">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[13.5px] font-semibold text-[var(--lp-ink)]">{t("consoleStaffCharterRecentShifts")}</h3>
          <button type="button" className="text-xs font-medium text-[var(--lp-accent)] hover:underline" onClick={onOpenShifts}>
            {t("consoleStaffCharterAllShifts")}
          </button>
        </div>
        {recentPreview.length === 0 ? (
          <p className="text-xs text-[var(--lp-muted)]">{t("consoleStaffShiftsNone")}</p>
        ) : (
          <ul className="space-y-3.5">
            {recentPreview.map((shift, idx) => (
              <li key={`${shift.at}-${idx}`} className="flex items-start gap-2.5">
                <span
                  className="mt-1.5 size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: SHIFT_DOT_COLOR[shiftOutcomeTone(shift.outcome)] }}
                  title={shift.outcome}
                  aria-label={shift.outcome}
                />
                <div className="min-w-0 space-y-0.5">
                  <div className="text-[11.5px] font-medium text-[var(--lp-muted)]">
                    {formatShiftTime(shift.at, locale)}
                    {shift.workflowId ? ` · ${shift.workflowId}` : ""}
                  </div>
                  <div className="text-[12.5px] leading-[1.4] text-[var(--lp-ink)]">{shift.depth}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
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
              const tone =
                cap.capUsd !== null && cap.capUsd > 0 && cap.usedUsd >= cap.capUsd
                  ? "bad"
                  : pct >= 80
                    ? "warn"
                    : "ok";

              return (
                <div key={cap.period} className="space-y-1.5" data-testid={`staff-cap-${cap.period}`}>
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-medium text-foreground">{t(CAP_PERIOD_KEYS[cap.period])}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatUsdAmount(cap.usedUsd, locale)} /{" "}
                      {cap.capUsd !== null ? formatUsdAmount(cap.capUsd, locale) : t("consoleStaffCapNoLimit")}
                    </span>
                  </div>
                  <ProgressBar value={pct} tone={tone} label={t(CAP_PERIOD_KEYS[cap.period])} testId={`staff-cap-bar-${cap.period}`} />
                </div>
              );
            })}
          </div>
        )}
      </SurfaceBody>
    </Surface>
  );
}
