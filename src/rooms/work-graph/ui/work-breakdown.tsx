import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import type { rpcContract } from "../../contracts";
import type { ExecutorRow, StageBlock, TaskGraph } from "../logic";
import { StageStrip } from "./stage-strip";
import { duration, fill, money, roleName, shortModel, stageName, stageState, tokens } from "./format";

const POLL_MS = 10_000;
/** A stage the project's settings turned off never ran: one line names them all instead of a card each. */
const isOff = (block: StageBlock) => block.cell.state === "skipped" && block.cell.rounds === 0;
const th = "px-1.5 py-1.5 text-left font-medium";
const td = "whitespace-nowrap px-1.5 py-1.5 tabular-nums";

function Cost({ row }: { row: ExecutorRow }) {
  if (row.costState === null) return <>—</>;
  if (row.costState === "not_measured") return <span className="text-muted-foreground" title={t("graphNotMeasuredHelp")}>{t("graphNotMeasured")}</span>;
  if (row.costUsd === null) return <span className="text-muted-foreground" title={t("graphPartialHelp")}>{t("graphPartial")}</span>;
  return <span title={t("graphEstimatedHelp")}>{money(row.costUsd)}</span>;
}

function StageCard({ block, locale, onThread }: { block: StageBlock; locale: string; onThread: (threadId: string) => void }) {
  const { cell, rows } = block;
  return (
    <section className="rounded-md border border-border" data-testid={`graph-stage-${cell.stageId}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-2.5">
        <StageStrip cells={[cell]} testId={`graph-cell-${cell.stageId}`} />
        <span className="text-sm font-semibold">{stageName(cell.stageId)}</span>
        <span className="text-xs text-muted-foreground">{stageState(cell.state)}</span>
      </div>
      <div className="px-3 pb-2 pt-0.5 text-xs text-muted-foreground">
        {fill("graphRounds", { n: cell.rounds, f: cell.failures })}
        {cell.reason ? <span className="mt-0.5 block break-words">{cell.reason}</span> : null}
      </div>
      {rows.length ? (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[36rem] text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className={th}>{t("graphRole")}</th><th className={th}>{t("graphRound")}</th><th className={th}>{t("graphModel")}</th>
                <th className={th}>{t("graphTurns")}</th><th className={th}>{t("graphTime")}</th><th className={th}>{t("graphFresh")}</th>
                <th className={th}>{t("graphCacheRead")}</th><th className={th}>{t("graphCacheWrite")}</th><th className={th}>{t("graphOutput")}</th>
                <th className={th}>{t("graphPrice")}</th><th className={th} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.threadId ?? "code"}:${row.round}:${index}`} className="border-b border-border/60 last:border-b-0" data-testid={`graph-row-${row.stageId}-${row.round}`}>
                  <td className={td}>{roleName(row.role)}</td>
                  <td className={td}>{row.round}</td>
                  <td className="px-1.5 py-1.5" title={row.model ?? ""}>{row.role === "code" ? "—" : shortModel(row.model)}</td>
                  <td className={td}>{row.turns ?? "—"}</td>
                  <td className={td}>{duration(row.seconds, locale)}</td>
                  <td className={td}>{tokens(row.tokens?.fresh, locale)}</td>
                  <td className={td}>{tokens(row.tokens?.cacheRead, locale)}</td>
                  <td className={td}>{tokens(row.tokens?.cacheWrite, locale)}</td>
                  <td className={td}>{tokens(row.tokens?.output, locale)}</td>
                  <td className={td}><Cost row={row} /></td>
                  <td className="px-1.5 py-1.5 text-right">
                    {row.threadId ? <button type="button" title={t("graphOpenThread")} aria-label={t("graphOpenThread")} className="rounded px-1 text-sm leading-none text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => onThread(row.threadId!)}>↗</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/** A task's run, stage by stage: the summary line, then who ran each stage with its rounds, model, turns, time, tokens and cost. */
export function WorkBreakdown({ runId, taskId, locale }: { runId: string; taskId: string; locale: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [graph, setGraph] = useState<TaskGraph | null>(null);
  const running = graph?.cells.some((cell) => cell.state === "running" || cell.state === "pending") ?? true;
  useEffect(() => {
    let alive = true;
    const read = () => void rpc.call("work_graph_task", { runId, taskId }).then((result) => { if (alive) setGraph(result as TaskGraph); }).catch(() => undefined);
    read();
    const timer = running ? setInterval(read, POLL_MS) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [rpc, runId, taskId, running]);
  if (!graph) return <p className="text-sm text-muted-foreground">{t("graphLoading")}</p>;
  if (!graph.cells.length) return <p className="text-sm text-muted-foreground">{t("graphNoStages")}</p>;
  const { summary } = graph;
  const off = graph.stages.filter(isOff);
  const cost = summary.costState === null ? "—" : summary.costUsd === null ? t("graphNotMeasured") : `${money(summary.costUsd)}${summary.costState === "partial" ? ` (${t("graphPartial")})` : ""}`;
  return (
    <div className="space-y-2.5" data-testid="work-breakdown">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <StageStrip cells={graph.cells} />
        <span>{fill("graphReturns", { n: summary.returns })}</span>
        <span title={summary.costState === "measured" ? t("graphEstimatedHelp") : t("graphPartialHelp")}>{fill("graphCost", { v: cost })}</span>
        <span>{fill("graphAgentTime", { v: duration(summary.seconds, locale) })}</span>
        {summary.models.length ? <span className="min-w-0 break-words">{summary.models.map((model) => shortModel(model)).join(" · ")}</span> : null}
      </div>
      {off.length ? <p className="text-xs text-muted-foreground" data-testid="graph-off">{fill("graphOff", { stages: off.map((block) => stageName(block.cell.stageId)).join(", ") })}</p> : null}
      {graph.stages.filter((block) => !isOff(block)).map((block) => <StageCard key={block.cell.stageId} block={block} locale={locale} onThread={(threadId) => navigate.toThread(threadId)} />)}
    </div>
  );
}
