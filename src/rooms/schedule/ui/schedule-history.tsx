import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import type { RunView, ScheduleView } from "../views";
import { HELPER_PANEL_ACTION } from "../../native-agent/ui/helper-threads";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { RunPill, errorText, fill, fmtTime } from "./schedule-parts";
import { usdText } from "./schedule-who";
import { modelShort, providerShort } from "../../workflow/ui/workflow-models";

const PAGE = 20;
const LIVE = new Set<RunView["status"]>(["queued", "running", "waiting"]);

/** Opens an errand's thread beside the page, as every helper thread opens; a page without a side panel navigates to it. */
export function useOpenRunThread() {
  const navigate = useBbNavigate();
  return (threadId: string, title: string) => {
    if (!navigate.openThreadPanel({ actionId: HELPER_PANEL_ACTION, title: title.slice(0, 40), params: { threadId } })) navigate.toThread(threadId);
  };
}

/** What a run used and where: the model and cost from the run thread's usage («unknown» when none was reported) and the machine it ran on. */
function RunMeta({ run }: { run: RunView }) {
  const thread = run.refKind === "thread";
  const cost = !run.usageKnown ? t("schRunCostUnknown") : run.costUsd === null ? t("schRunCostNoPrice") : fill(t("schRunCost"), { usd: usdText(run.costUsd) });
  const model = [providerShort(run.providerId), modelShort(run.model)].filter(Boolean).join(" · ");
  if (!model && !thread && !run.hostName) return null;
  return (
    <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground" data-testid={`sch-run-meta-${run.id}`}>
      {model ? <span className="min-w-0 break-words" data-testid={`sch-run-model-${run.id}`}>{fill(t("schRunModel"), { model })}</span> : null}
      {thread ? <span data-testid={`sch-run-cost-${run.id}`} data-known={run.usageKnown ? "1" : "0"}>{cost}</span> : null}
      {run.hostName ? <span className="min-w-0 break-words" data-testid={`sch-run-host-${run.id}`}>{fill(t("schMachine"), { name: run.hostName })}</span> : null}
    </p>
  );
}

export function RunRow({ run, name, onCancel }: { run: RunView; name: string; onCancel?: (runId: string) => void }) {
  const openThread = useOpenRunThread();
  const detail = [run.reason, run.exitCode !== null ? fill(t("schHistoryExit"), { n: run.exitCode }) : null, run.durationMs !== null ? fill(t("schHistoryDuration"), { n: Math.round(run.durationMs / 1000) }) : null].filter(Boolean).join(" · ");
  return (
    <li className="space-y-1 py-2.5" data-testid={`sch-run-${run.id}`} data-status={run.status}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <RunPill status={run.status} testId={`sch-run-status-${run.id}`} />
        <span className="text-muted-foreground">{fmtTime(run.startedAt ?? run.scheduledAt)}</span>
        <span className="text-muted-foreground">{t(`schTrigger_${run.trigger}` as I18nKey)}</span>
        {detail ? <span className="min-w-0 break-words text-muted-foreground">{detail}</span> : null}
        <span className="ml-auto flex gap-1">
          {run.refKind === "thread" && run.refId ? <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" data-testid={`sch-run-open-${run.id}`} onClick={() => openThread(run.refId!, name)}>{t("schOpenThread")}</Button> : null}
          {run.refKind && run.refKind !== "thread" && run.refId ? <span className="font-mono text-[11px] text-muted-foreground" data-testid={`sch-run-ref-${run.id}`}>{run.refKind} {run.refId}</span> : null}
          {onCancel && LIVE.has(run.status) ? <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" data-testid={`sch-run-cancel-${run.id}`} onClick={() => onCancel(run.id)}>{t("schCancelRun")}</Button> : null}
        </span>
      </div>
      <RunMeta run={run} />
      {run.error ? <p className="break-words text-xs text-destructive-text" data-testid={`sch-run-error-${run.id}`}>{t("schHistoryError")}: {run.error}</p> : null}
      {run.output ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t("schHistoryOutput")}{run.truncated ? ` ${t("schHistoryTruncated")}` : ""}</summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--lp-well)] p-2 font-mono text-[11px] leading-4" data-testid={`sch-run-output-${run.id}`}>{run.output}</pre>
        </details>
      ) : null}
    </li>
  );
}

/** The runs of one schedule, newest first, a page at a time; a live run can be stopped from here. */
export function ScheduleHistory({ schedule, refreshKey, onBack, onChanged }: { schedule: ScheduleView; refreshKey: number; onBack: () => void; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  // The first page is re-read on every signal; older pages already loaded stay under it.
  const load = useCallback(async (offset: number) => {
    try {
      const page = await rpc.call("schedule_runs", { id: schedule.id, limit: PAGE, offset });
      setTotal(page.total);
      setRuns((current) => offset === 0 ? (current && current.length > PAGE ? [...page.runs, ...current.slice(PAGE)] : page.runs) : [...(current ?? []), ...page.runs]);
      setFailure(null);
    } catch (cause) { setFailure(errorText(cause)); }
  }, [rpc, schedule.id]);
  useEffect(() => { void load(0); }, [load, refreshKey]);

  const cancel = async (runId: string) => {
    try { await rpc.call("schedule_cancel_run", { runId }); onChanged(); void load(0); } catch (cause) { setFailure(fill(t("schActionError"), { reason: errorText(cause) })); }
  };

  return (
    <Surface testId="schedule-history">
      <SurfaceHeader className="flex-wrap justify-between gap-2">
        <h2 className="min-w-0 break-words text-sm font-medium">{fill(t("schHistoryTitle"), { name: schedule.name })}</h2>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" data-testid="sch-history-back" onClick={onBack}>‹ {t("schBack")}</Button>
      </SurfaceHeader>
      <SurfaceBody>
        {failure ? <p className="break-words text-xs text-destructive-text" role="alert">{failure}</p> : null}
        {runs === null ? <p className="text-xs text-muted-foreground" role="status">{t("schLoading")}</p>
          : runs.length === 0 ? <p className="text-xs text-muted-foreground" data-testid="sch-history-none">{t("schHistoryNone")}</p>
            : <ul className="divide-y divide-border/60" data-testid="sch-history-list">{runs.map((run) => <RunRow key={run.id} run={run} name={schedule.name} onCancel={(id) => void cancel(id)} />)}</ul>}
        {runs && runs.length < total ? <Button type="button" size="sm" variant="outline" className="h-8 px-3 text-sm" data-testid="sch-history-more" onClick={() => void load(runs.length)}>{t("schHistoryMore")}</Button> : null}
      </SurfaceBody>
    </Surface>
  );
}
