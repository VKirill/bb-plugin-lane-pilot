import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button, StatusPill, type StatusPillTone } from "@lane-pilot/ui-kit";
import type { AcceptanceCard } from "../../contracts";
import type { TaskHistoryRow } from "../../contracts/ui";
import { stageName, stageState, type TaskCardData } from "./task-shared";

export type HistoryDetailState =
  | { status: "loading" }
  | { status: "ready"; card: TaskCardData | null; acceptance: AcceptanceCard | null }
  | { status: "error"; message: string };

interface CheckEntry {
  key: string;
  label: string;
  status: string;
  tone: StatusPillTone;
  detail: string | null;
}

function receiptTone(state: string): StatusPillTone {
  if (state === "passed" || state === "succeeded" || state === "green") return "ok";
  if (state === "failed" || state === "blocked" || state === "red") return "bad";
  if (state === "running" || state === "waiting") return "warn";
  return "muted";
}

function collectChecks(card: TaskCardData | null, acceptance: AcceptanceCard | null): CheckEntry[] {
  const entries: CheckEntry[] = [];
  if (acceptance?.baseline?.checks.length) {
    for (const [index, check] of acceptance.baseline.checks.entries()) {
      entries.push({
        key: `base:${index}:${check.command}`,
        label: check.command,
        status: t(`acc_baseline_${check.status}` as I18nKey),
        tone: receiptTone(check.status),
        detail: check.note || null,
      });
    }
  }
  if (acceptance?.receipts.length) {
    for (const receipt of acceptance.receipts) {
      entries.push({
        key: `receipt:${receipt.stageId}`,
        label: stageName(receipt.stageId),
        status: stageState(receipt.state),
        tone: receiptTone(receipt.state),
        detail: receipt.reason,
      });
    }
  } else if (card?.stages.length) {
    for (const [index, stage] of card.stages.entries()) {
      entries.push({
        key: `stage:${stage.id}:${index}`,
        label: stage.title ?? stageName(stage.id),
        status: stageState(stage.state),
        tone: receiptTone(stage.state),
        detail: stage.reason,
      });
    }
  }
  if (acceptance?.gates.length) {
    for (const [index, gate] of acceptance.gates.entries()) {
      entries.push({
        key: `gate:${gate.gate}:${index}`,
        label: gate.gate,
        status: gate.status,
        tone: receiptTone(gate.status),
        detail: null,
      });
    }
  }
  if (entries.length === 0 && card?.contract?.checks.length) {
    for (const [index, command] of card.contract.checks.entries()) {
      entries.push({
        key: `contract:${index}:${command}`,
        label: command,
        status: t("stage_state_pending"),
        tone: "muted",
        detail: null,
      });
    }
  }
  return entries;
}

export interface HistoryDetailProps {
  row: TaskHistoryRow;
  detail: HistoryDetailState | undefined;
  onRetryWithNewPlan: (row: TaskHistoryRow) => void;
  onReloadDetail: (row: TaskHistoryRow) => void;
  onOpenTask?: (runId: string, taskId: string) => void;
  onOpenLesson?: (projectId: string, memoryId: string) => void;
}

/** Expanded diagnostics panel for failed or canceled history rows. */
export function HistoryDetail({
  row,
  detail,
  onRetryWithNewPlan,
  onReloadDetail,
  onOpenTask,
  onOpenLesson,
}: HistoryDetailProps) {
  const card = detail?.status === "ready" ? detail.card : null;
  const acceptance = detail?.status === "ready" ? detail.acceptance : null;
  const reason = card?.reason ?? row.failureReason;
  const checks = collectChecks(card, acceptance);
  const reasonLabel = row.outcome === "canceled" ? t("consoleHistoryCancelReason") : t("consoleHistoryFailureReason");

  return (
    <div
      className="space-y-3 rounded-md border border-destructive/20 bg-destructive/[0.03] px-4 py-3 text-sm"
      data-testid={`history-detail-${row.taskId}`}
    >
      {detail?.status === "loading" ? (
        <p className="text-xs text-muted-foreground" role="status" data-testid={`history-detail-loading-${row.taskId}`}>
          {t("boardLoading")}
        </p>
      ) : detail?.status === "error" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" data-testid={`history-detail-error-${row.taskId}`}>
          <span>{detail.message || t("consoleHistoryDetailError")}</span>
          <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => onReloadDetail(row)}>
            {t("consoleOverviewRetry")}
          </Button>
        </div>
      ) : null}

      {reason ? (
        <p className="whitespace-pre-wrap break-words text-sm text-foreground" data-testid={`history-detail-reason-${row.taskId}`}>
          <span className="font-medium text-muted-foreground">{reasonLabel}: </span>
          {reason}
        </p>
      ) : null}

      {detail?.status === "ready" ? (
        <div className="space-y-1.5" data-testid={`history-detail-checks-${row.taskId}`}>
          <div className="text-xs font-medium text-muted-foreground">{t("consoleHistoryChecksTitle")}</div>
          {checks.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("consoleHistoryChecksNone")}</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {checks.map((check) => (
                <li key={check.key} className="flex flex-wrap items-baseline gap-2">
                  <StatusPill tone={check.tone}>{check.status}</StatusPill>
                  <span className="font-medium text-foreground">{check.label}</span>
                  {check.detail ? (
                    <span className="min-w-0 break-words text-muted-foreground">{check.detail}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-xs">
        <button
          type="button"
          data-testid={`history-plan-link-${row.taskId}`}
          className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          onClick={() => onOpenTask?.(row.runId, row.taskId)}
        >
          {t("consoleHistoryPlanLink")}
        </button>

        {row.lessonMemoryId ? (
          <button
            type="button"
            data-testid={`history-lesson-link-${row.taskId}`}
            className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            onClick={() => onOpenLesson?.(row.projectId, row.lessonMemoryId!)}
          >
            {t("consoleHistoryLessonLink")}
          </button>
        ) : null}

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-7 px-2.5 text-xs"
          data-testid={`history-retry-plan-${row.taskId}`}
          onClick={() => onRetryWithNewPlan(row)}
        >
          {t("consoleHistoryRetryNewPlan")}
        </Button>
      </div>
    </div>
  );
}
