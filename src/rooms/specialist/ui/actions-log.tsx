import { useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { detectLocale, t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ConfirmDialog,
  Icon,
  Skeleton,
  StatusPill,
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
import type { rpcContract } from "../../contracts";
import type { ActionsLogOutput, AutonomousAction } from "../../contracts/ui";
import { useLpRpcQuery } from "../../ui-shell/ui";
import { isAllowedUndoMethod } from "../models/actions-log";

const ACTIONS_POLL_MS = 30_000;
const PAGE_LIMIT = 50;

const AUTHORITY_LABEL_KEYS: Record<AutonomousAction["authority"], I18nKey> = {
  bounded_auto: "consoleActionsAuth_bounded_auto",
  repo_rule: "consoleActionsAuth_repo_rule",
  maintenance: "consoleActionsAuth_maintenance",
};

const RESULT_PILLS: Record<AutonomousAction["result"], { tone: StatusPillTone; labelKey: I18nKey }> = {
  done: { tone: "ok", labelKey: "consoleActionsResult_done" },
  reverted: { tone: "muted", labelKey: "consoleActionsResult_reverted" },
  failed: { tone: "bad", labelKey: "consoleActionsResult_failed" },
};

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  return fallback;
}

function formatActionTime(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

export interface ActionsLogProps {
  projectId: string | null;
  locale?: Locale;
  onOpenTask?: (runId: string, taskId: string) => void;
  onOpenWork?: () => void;
}

/** Decisions — Done-without-you tab (P2): autonomous actions feed with `since` pagination and allow-listed confirmed undo. */
export function ActionsLog({ projectId, locale: localeProp, onOpenTask, onOpenWork }: ActionsLogProps) {
  const locale = localeProp ?? detectLocale();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const firstPageInput = useMemo(
    () => ({
      ...(projectId ? { projectId } : {}),
      limit: PAGE_LIMIT,
    }),
    [projectId],
  );

  const query = useLpRpcQuery<ActionsLogOutput>("actions_log", firstPageInput, { pollMs: ACTIONS_POLL_MS });

  const [extraRows, setExtraRows] = useState<AutonomousAction[]>([]);
  const [lastBatchSize, setLastBatchSize] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [pendingUndo, setPendingUndo] = useState<AutonomousAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const scopeSeq = useRef(0);

  useEffect(() => {
    scopeSeq.current += 1;
    setExtraRows([]);
    setLastBatchSize(null);
    setLoadingMore(false);
    setExhausted(false);
    setPendingUndo(null);
    setRowErrors({});
  }, [projectId]);

  const rows = useMemo(() => {
    const base = query.data?.rows ?? [];
    if (extraRows.length === 0) return base;
    const seen = new Set(base.map((row) => row.id));
    return [...base, ...extraRows.filter((row) => !seen.has(row.id))];
  }, [query.data?.rows, extraRows]);

  const hasMore =
    !exhausted &&
    (lastBatchSize !== null ? lastBatchSize >= PAGE_LIMIT : (query.data?.rows.length ?? 0) >= PAGE_LIMIT);

  const handleLoadMore = async () => {
    const oldestAt = rows[rows.length - 1]?.at;
    if (oldestAt === undefined || loadingMore) return;
    const seq = scopeSeq.current;
    setLoadingMore(true);
    try {
      const nextPage = await rpc.call("actions_log", {
        ...(projectId ? { projectId } : {}),
        before: oldestAt,
        limit: PAGE_LIMIT,
      });
      if (scopeSeq.current !== seq) return;
      const existingIds = new Set(rows.map((row) => row.id));
      const added = nextPage.rows.filter((row) => !existingIds.has(row.id));
      setExtraRows((prev) => {
        const seen = new Set(prev.map((row) => row.id));
        return [...prev, ...added.filter((row) => !seen.has(row.id))];
      });
      setLastBatchSize(nextPage.rows.length);
      if (nextPage.rows.length < PAGE_LIMIT || added.length === 0) {
        setExhausted(true);
      }
    } catch (cause) {
      if (scopeSeq.current !== seq) return;
      toast.error(errorMessage(cause, t("consoleActionsLoadError")));
    } finally {
      if (scopeSeq.current === seq) setLoadingMore(false);
    }
  };

  const handleOpenEvidence = (evidenceRef: string) => {
    const taskPairMatch = /^([^:\s]+):([^:\s]+)$/.exec(evidenceRef);
    if (taskPairMatch?.[1] && taskPairMatch[2] && !evidenceRef.startsWith("nonce")) {
      if (onOpenTask) onOpenTask(taskPairMatch[1], taskPairMatch[2]);
      else navigate?.toPluginPanel?.("lane-pilot", { subPath: `work/task/${taskPairMatch[1]}/${taskPairMatch[2]}` });
      return;
    }
    if (/^run_/.test(evidenceRef)) {
      if (onOpenWork) onOpenWork();
      else navigate?.toPluginPanel?.("lane-pilot", { subPath: "work/tasks" });
      return;
    }
    if (/^thr_/.test(evidenceRef)) {
      const threadId = evidenceRef.split(/[#:]/)[0];
      if (threadId) {
        navigate?.toThread?.(threadId);
        return;
      }
    }
    void navigator.clipboard
      ?.writeText(evidenceRef)
      .then(() => {
        toast.success(t("consoleActionsEvidenceCopied"));
      })
      .catch(() => undefined);
  };

  const handleUndoConfirm = async () => {
    const target = pendingUndo;
    if (!target?.undo || !isAllowedUndoMethod(target.undo.method)) return;
    const { method, input } = target.undo;
    setBusyId(target.id);
    setRowErrors((prev) => {
      if (!(target.id in prev)) return prev;
      const next = { ...prev };
      delete next[target.id];
      return next;
    });
    try {
      const reply = (await (rpc.call as (m: string, i: unknown) => Promise<unknown>)(method, input)) as
        | { ok?: unknown; reason?: unknown; message?: unknown }
        | null
        | undefined;
      if (reply && typeof reply === "object" && reply.ok === false) {
        const msg =
          (typeof reply.reason === "string" && reply.reason) ||
          (typeof reply.message === "string" && reply.message) ||
          t("consoleActionsUndoFailed");
        throw new Error(msg);
      }
      toast.success(t("consoleActionsUndoDone"));
      setExtraRows([]);
      setLastBatchSize(null);
      setExhausted(false);
      await query.refetch();
    } catch (cause) {
      const message = errorMessage(cause, t("consoleActionsUndoFailed"));
      console.warn("[lane-pilot:actions] undo failed", method);
      setRowErrors((prev) => ({ ...prev, [target.id]: message }));
      toast.error(t("consoleActionsUndoFailed"), { description: message });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="actions-log">
      {query.error ? (
        <Alert variant="destructive" data-testid="actions-log-error">
          <AlertTitle>{t("consoleActionsLoadError")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{errorMessage(query.error, t("consoleActionsLoadError"))}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="actions-log-retry"
              onClick={() => void query.refetch()}
            >
              {t("consoleOverviewRetry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!query.data && query.isLoading ? (
        <div
          className="space-y-2"
          data-testid="actions-log-loading"
          aria-busy="true"
          aria-label={t("consoleActionsLoading")}
        >
          <Skeleton className="h-24 rounded-[14px]" />
          <Skeleton className="h-24 rounded-[14px]" />
        </div>
      ) : query.data && rows.length === 0 ? (
        <Surface testId="actions-log-empty">
          <SurfaceBody>
            <p className="text-sm text-muted-foreground">{t("consoleActionsEmpty")}</p>
          </SurfaceBody>
        </Surface>
      ) : query.data ? (
        <Surface testId="actions-log-table-card">
          <Table data-testid="actions-log-table">
            <TableHeader>
              <TableRow>
                <TableHead>{t("consoleActionsColTime")}</TableHead>
                <TableHead>{t("consoleActionsColActor")}</TableHead>
                <TableHead>{t("consoleActionsColAction")}</TableHead>
                <TableHead>{t("consoleActionsColAuthority")}</TableHead>
                <TableHead>{t("consoleActionsColResult")}</TableHead>
                <TableHead>{t("consoleActionsColEvidence")}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("consoleActionsUndo")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const pill = RESULT_PILLS[row.result];
                const canUndo =
                  row.undo !== null && isAllowedUndoMethod(row.undo.method) && row.result !== "reverted";
                const rowError = rowErrors[row.id];
                return (
                  <TableRow key={row.id} data-testid={`actions-log-row-${row.id}`}>
                    <TableCell
                      className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                      title={new Date(row.at).toISOString()}
                    >
                      {formatActionTime(row.at, locale)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-foreground">
                      {row.actor}
                    </TableCell>
                    <TableCell className="max-w-[20rem] text-xs text-foreground">
                      <div className="break-words font-medium">{row.action}</div>
                      {rowError ? (
                        <p
                          role="alert"
                          className="mt-1 text-xs text-destructive"
                          data-testid={`actions-log-error-${row.id}`}
                        >
                          {rowError}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone="muted">{t(AUTHORITY_LABEL_KEYS[row.authority])}</StatusPill>
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={pill.tone}>{t(pill.labelKey)}</StatusPill>
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.evidenceRef ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          data-testid={`actions-log-evidence-${row.id}`}
                          onClick={() => handleOpenEvidence(row.evidenceRef!)}
                        >
                          <Icon name="ArrowUpRight" className="size-3 shrink-0" aria-hidden />
                          <span className="max-w-[10rem] truncate">{row.evidenceRef}</span>
                        </button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {canUndo ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busyId !== null}
                          data-testid={`actions-log-undo-${row.id}`}
                          onClick={() => setPendingUndo(row)}
                        >
                          {t("consoleActionsUndo")}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Surface>
      ) : null}

      {hasMore ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loadingMore}
            data-testid="actions-log-load-more"
            onClick={() => void handleLoadMore()}
          >
            {loadingMore ? t("consoleActionsLoading") : t("consoleActionsLoadMore")}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingUndo !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUndo(null);
        }}
        title={t("consoleActionsConfirmUndoTitle")}
        body={
          pendingUndo?.undo
            ? t("consoleActionsConfirmUndoBody")
                .replace("{method}", pendingUndo.undo.method)
                .replace("{action}", pendingUndo.action)
            : ""
        }
        tone="danger"
        confirmLabel={t("consoleActionsConfirmUndoConfirm")}
        cancelLabel={t("consoleActionsConfirmUndoCancel")}
        onConfirm={handleUndoConfirm}
      />
    </div>
  );
}
