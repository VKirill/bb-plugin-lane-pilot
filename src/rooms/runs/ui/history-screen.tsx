import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { TASK_OUTCOMES, type TaskOutcome } from "@lane-pilot/contracts";
import { detectLocale, t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ConfirmDialog,
  Icon,
  Surface,
  SurfaceBody,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type StatusPillTone,
} from "@lane-pilot/ui-kit";
import { toast } from "sonner";
import type { AcceptanceCard, rpcContract } from "../../contracts";
import type { TaskHistoryRow } from "../../contracts/ui";
import { HistoryDetail, type HistoryDetailState } from "./history-detail";
import { shortTaskId, type TaskCardData } from "./task-shared";

type OutcomeFilter = "all" | TaskOutcome;

const PAGE_LIMIT = 30;
const RETRY_NOTE_MAX = 4000;

const OUTCOME_FILTER_LABELS: Record<OutcomeFilter, I18nKey> = {
  all: "consoleHistoryFilterAll",
  accepted: "consoleHistoryFilterAccepted",
  reworked: "consoleHistoryFilterReworked",
  canceled: "consoleHistoryFilterCanceled",
  failed: "consoleHistoryFilterFailed",
};

const OUTCOME_PILLS: Record<TaskOutcome, { tone: StatusPillTone; labelKey: I18nKey }> = {
  accepted: { tone: "ok", labelKey: "consoleHistoryOutcomeAccepted" },
  reworked: { tone: "warn", labelKey: "consoleHistoryOutcomeReworked" },
  canceled: { tone: "muted", labelKey: "consoleHistoryOutcomeCanceled" },
  failed: { tone: "bad", labelKey: "consoleHistoryOutcomeFailed" },
};

function isExpandableOutcome(outcome: TaskOutcome): boolean {
  return outcome === "failed" || outcome === "canceled";
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  const totalSec = Math.round(durationMs / 1000);
  if (totalSec < 60) return t("consoleHistoryDurationSec").replace("{n}", String(totalSec));
  const totalMin = Math.round(durationMs / 60_000);
  if (totalMin < 60) return t("consoleOverviewElapsedMin").replace("{n}", String(totalMin));
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (mins === 0) return t("consoleOverviewElapsedHour").replace("{n}", String(hours));
  return t("consoleHistoryDurationHourMin").replace("{h}", String(hours)).replace("{m}", String(mins));
}

function formatCost(costUsd: number | null, locale: Locale): string {
  if (costUsd === null || !Number.isFinite(costUsd)) return "—";
  const digits = costUsd !== 0 && Math.abs(costUsd) < 0.01 ? 4 : 2;
  return `$${costUsd.toLocaleString(locale === "ru" ? "ru-RU" : "en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function formatFinishedAt(ms: number, locale: Locale): string {
  return new Date(ms).toLocaleString(locale === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface HistoryScreenProps {
  projectId: string | null;
  sectionId?: string | null;
  projects: ReadonlyArray<{ id: string; name: string }>;
  locale?: Locale;
  onOpenTask?: (runId: string, taskId: string) => void;
  onOpenLesson?: (projectId: string, memoryId: string) => void;
}

/** P8 Task history screen: outcome filter, cursor pagination, SHA copy, expandable failed/canceled diagnostics, and return-to-planning dialog. */
export function HistoryScreen({
  projectId,
  sectionId,
  projects,
  locale: localeProp,
  onOpenTask,
  onOpenLesson,
}: HistoryScreenProps) {
  const locale = localeProp ?? detectLocale();
  const rpc = useRpc<typeof rpcContract>();

  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const [rows, setRows] = useState<TaskHistoryRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [details, setDetails] = useState<Record<string, HistoryDetailState>>({});
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);

  const [retryTarget, setRetryTarget] = useState<TaskHistoryRow | null>(null);
  const [retryNote, setRetryNote] = useState("");

  const querySeq = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name] as const)), [projects]);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const buildInput = useCallback(
    (cursor?: string) => ({
      ...(projectId ? { projectId } : {}),
      ...(sectionId ? { sectionId } : {}),
      ...(outcomeFilter !== "all" ? { outcome: outcomeFilter } : {}),
      ...(cursor ? { cursor } : {}),
      limit: PAGE_LIMIT,
    }),
    [projectId, sectionId, outcomeFilter],
  );

  const loadFirstPage = useCallback(async () => {
    const seq = ++querySeq.current;
    setLoadError(null);
    setLoadingMore(false);
    try {
      const res = await rpc.call("task_history", buildInput());
      if (querySeq.current !== seq) return;
      setRows(res.rows);
      setNextCursor(res.nextCursor);
    } catch (cause) {
      if (querySeq.current !== seq) return;
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      setRows((prev) => prev ?? []);
    }
  }, [rpc, buildInput]);

  useEffect(() => {
    setRows(null);
    setNextCursor(null);
    setExpanded(new Set());
    setDetails({});
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const seq = querySeq.current;
    setLoadingMore(true);
    try {
      const res = await rpc.call("task_history", buildInput(nextCursor));
      if (querySeq.current !== seq) return;
      setRows((prev) => {
        const current = prev ?? [];
        const seen = new Set(current.map((item) => item.taskId));
        return [...current, ...res.rows.filter((item) => !seen.has(item.taskId))];
      });
      setNextCursor(res.nextCursor);
    } catch (cause) {
      if (querySeq.current !== seq) return;
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (querySeq.current === seq) setLoadingMore(false);
    }
  };

  const fetchDetail = useCallback(
    async (row: TaskHistoryRow) => {
      setDetails((prev) => ({ ...prev, [row.taskId]: { status: "loading" } }));
      const [cardRes, accRes] = await Promise.allSettled([
        rpc.call("task_card", { runId: row.runId, taskId: row.taskId }),
        rpc.call("task_acceptance_card", { runId: row.runId, taskId: row.taskId }),
      ]);
      if (cardRes.status === "rejected" && accRes.status === "rejected") {
        const message =
          cardRes.reason instanceof Error
            ? cardRes.reason.message
            : accRes.reason instanceof Error
              ? accRes.reason.message
              : t("consoleHistoryDetailError");
        setDetails((prev) => ({ ...prev, [row.taskId]: { status: "error", message } }));
        return;
      }
      const card = cardRes.status === "fulfilled" ? (cardRes.value as TaskCardData | null) : null;
      const acceptance = accRes.status === "fulfilled" ? (accRes.value as AcceptanceCard | null) : null;
      setDetails((prev) => ({ ...prev, [row.taskId]: { status: "ready", card, acceptance } }));
    },
    [rpc],
  );

  const toggleRow = (row: TaskHistoryRow) => {
    const opening = !expanded.has(row.taskId);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(row.taskId);
      else next.delete(row.taskId);
      return next;
    });
    if (opening && !details[row.taskId]) {
      void fetchDetail(row);
    }
  };

  const copySha = (taskId: string, sha: string) => {
    void navigator.clipboard?.writeText(sha).then(
      () => {
        setCopiedTaskId(taskId);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopiedTaskId(null), 1500);
      },
      () => undefined,
    );
  };

  const handleRetryConfirm = async () => {
    if (!retryTarget) return;
    const note = retryNote.trim();
    if (!note) {
      throw new Error(t("consoleHistoryRetryNoteRequired"));
    }
    const answer = await rpc.call("task_return_stage", {
      ref: retryTarget.taskId,
      to: "planning",
      by: "owner",
      note,
    });
    const reply = answer as { ok?: boolean; reason?: string } | null;
    if (reply && reply.ok === false) {
      throw new Error(reply.reason ?? t("ret_failed"));
    }
    toast.success(t("ret_ok"));
    setRetryNote("");
    await loadFirstPage();
  };

  const filterChips: OutcomeFilter[] = ["all", ...TASK_OUTCOMES];

  return (
    <div className="space-y-4" data-testid="history-screen">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("consoleHistoryColOutcome")}>
        {filterChips.map((chip) => (
          <button
            key={chip}
            type="button"
            aria-pressed={outcomeFilter === chip}
            data-testid={`history-filter-${chip}`}
            className="lp-wm-chip"
            onClick={() => setOutcomeFilter(chip)}
          >
            <span>{t(OUTCOME_FILTER_LABELS[chip])}</span>
          </button>
        ))}
      </div>

      {loadError ? (
        <Alert variant="destructive" data-testid="history-error">
          <AlertTitle>{t("consoleHistoryLoadError")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{loadError}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void loadFirstPage()}>
              {t("consoleOverviewRetry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {rows === null ? (
        <p className="text-sm text-muted-foreground" role="status" data-testid="history-loading">
          {t("consoleHistoryLoading")}
        </p>
      ) : rows.length === 0 ? (
        <Surface testId="history-empty">
          <SurfaceBody>
            <p className="text-sm text-muted-foreground">{t("consoleHistoryEmpty")}</p>
          </SurfaceBody>
        </Surface>
      ) : (
        <Surface testId="history-table-card" className="overflow-hidden">
          <Table data-testid="history-table" className="lp-wm-table">
            <TableHeader>
              <TableRow>
                <TableHead>{t("consoleHistoryColTask")}</TableHead>
                {projectId === null ? <TableHead className="lp-wm-hide-sm">{t("consoleHistoryColProject")}</TableHead> : null}
                <TableHead>{t("consoleHistoryColOutcome")}</TableHead>
                <TableHead className="lp-wm-hide-sm">{t("consoleHistoryColAttempts")}</TableHead>
                <TableHead className="lp-wm-hide-sm">{t("consoleHistoryColDuration")}</TableHead>
                <TableHead className="lp-wm-hide-sm">{t("consoleHistoryColCost")}</TableHead>
                <TableHead className="lp-wm-hide-sm">{t("consoleHistoryColCommit")}</TableHead>
                <TableHead className="lp-wm-hide-sm">{t("consoleHistoryColFinished")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const expandable = isExpandableOutcome(row.outcome);
                const isExpanded = expandable && expanded.has(row.taskId);
                const pill = OUTCOME_PILLS[row.outcome];
                const projectLabel = projectNames.get(row.projectId) ?? row.projectId;
                const copied = copiedTaskId === row.taskId;

                return (
                  <Fragment key={row.taskId}>
                    <TableRow data-testid={`history-row-${row.taskId}`} className={isExpanded ? "lp-wm-row-open" : undefined} data-outcome={row.outcome}>
                      <TableCell className="lp-wm-cell-strong lp-wm-title-cell w-full max-w-0">
                        {expandable ? (
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            data-testid={`history-toggle-${row.taskId}`}
                            onClick={() => toggleRow(row)}
                            className="flex w-full min-w-0 items-center gap-2 text-left hover:underline"
                          >
                            <Icon
                              name={isExpanded ? "ChevronDown" : "ChevronRight"}
                              className="size-3.5 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                            <span className="min-w-0 truncate">{row.title}</span>
                            <span className="lp-wm-hide-sm shrink-0 font-mono text-[11px] font-normal text-muted-foreground">
                              {shortTaskId(row.taskId)}
                            </span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            data-testid={`history-open-${row.taskId}`}
                            onClick={() => onOpenTask?.(row.runId, row.taskId)}
                            className="flex w-full min-w-0 items-center gap-2 text-left hover:underline"
                          >
                            <span className="min-w-0 truncate">{row.title}</span>
                            <span className="lp-wm-hide-sm shrink-0 font-mono text-[11px] font-normal text-muted-foreground">
                              {shortTaskId(row.taskId)}
                            </span>
                          </button>
                        )}
                      </TableCell>
                      {projectId === null ? <TableCell className="lp-wm-hide-sm whitespace-nowrap">{projectLabel}</TableCell> : null}
                      <TableCell>
                        <span data-testid={`history-outcome-${row.taskId}`}>
                          <span className="lp-wm-outcome" data-tone={pill.tone}>{t(pill.labelKey)}</span>
                        </span>
                      </TableCell>
                      <TableCell className="lp-wm-hide-sm whitespace-nowrap tabular-nums">
                        {row.attempts > 0 ? row.attempts : "—"}
                      </TableCell>
                      <TableCell className="lp-wm-hide-sm whitespace-nowrap tabular-nums">
                        {formatDuration(row.durationMs)}
                      </TableCell>
                      <TableCell className="lp-wm-hide-sm whitespace-nowrap tabular-nums">
                        {formatCost(row.costUsd, locale)}
                      </TableCell>
                      <TableCell className="lp-wm-hide-sm">
                        {row.mergeSha ? (
                          <span className="inline-flex items-center gap-1 font-mono">
                            <span title={row.mergeSha}>{row.mergeSha.slice(0, 7)}</span>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-1.5 text-[11px]"
                              aria-label={copied ? t("consoleHistoryCopiedSha") : t("consoleHistoryCopySha")}
                              data-testid={`history-copy-sha-${row.taskId}`}
                              onClick={() => copySha(row.taskId, row.mergeSha!)}
                            >
                              <Icon name={copied ? "Check" : "Copy"} className="size-3" aria-hidden />
                            </Button>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="lp-wm-hide-sm whitespace-nowrap tabular-nums">
                        {formatFinishedAt(row.finishedAt, locale)}
                      </TableCell>
                    </TableRow>
                    {isExpanded ? (
                      <TableRow className="lp-wm-row-open" data-outcome={row.outcome}>
                        <TableCell colSpan={projectId === null ? 8 : 7} className="lp-wm-row-detail">
                          <HistoryDetail
                            row={row}
                            detail={details[row.taskId]}
                            onRetryWithNewPlan={(target) => {
                              setRetryNote("");
                              setRetryTarget(target);
                            }}
                            onReloadDetail={(target) => void fetchDetail(target)}
                            onOpenTask={onOpenTask}
                            onOpenLesson={onOpenLesson}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </Surface>
      )}

      {nextCursor ? (
        <button type="button" className="lp-wm-more" disabled={loadingMore} data-testid="history-load-more" onClick={() => void loadMore()}>
          {loadingMore ? t("boardLoading") : t("consoleHistoryLoadMore")}
        </button>
      ) : null}

      <ConfirmDialog
        open={retryTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRetryTarget(null);
        }}
        title={t("consoleHistoryRetryTitle")}
        confirmLabel={t("consoleHistoryRetryNewPlan")}
        cancelLabel={t("cancel")}
        onConfirm={handleRetryConfirm}
        body={
          <div className="space-y-3">
            <p>{t("consoleHistoryRetryBody")}</p>
            {retryTarget ? (
              <p className="text-xs font-medium text-foreground">{retryTarget.title}</p>
            ) : null}
            <label className="block space-y-1">
              <span className="text-xs font-medium text-foreground">{t("consoleHistoryRetryNoteLabel")}</span>
              <textarea
                value={retryNote}
                maxLength={RETRY_NOTE_MAX}
                onChange={(event) => setRetryNote(event.target.value)}
                placeholder={t("consoleHistoryRetryNotePlaceholder")}
                data-testid="history-retry-note"
                rows={3}
                className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                autoFocus
              />
            </label>
          </div>
        }
      />
    </div>
  );
}
