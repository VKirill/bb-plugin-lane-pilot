import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import type { rpcContract } from "../../contracts";
import type { ExecutorRow, StageBlock, TaskGraph } from "../logic";
import { StageStrip } from "./stage-strip";
import { duration, fill, money, roleName, shortModel, stageName, stageState } from "./format";

const POLL_MS = 8_000;
const isOff = (block: StageBlock) => block.cell.state === "skipped" && block.cell.rounds === 0;
const costText = (row: ExecutorRow) => (row.costState === null ? null : row.costUsd !== null ? money(row.costUsd) : t(row.costState === "not_measured" ? "graphNotMeasured" : "graphPartial"));

/** A task step by step, narrow enough for a side panel: one line per stage, who ran it, how long, what it cost, the thread to open. */
export function StageSteps({ runId, taskId, locale }: { runId: string; taskId: string; locale: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [graph, setGraph] = useState<TaskGraph | null>(null);
  const live = graph?.cells.some((cell) => cell.state === "running" || cell.state === "pending") ?? true;
  useEffect(() => {
    let alive = true;
    const read = () => void rpc.call("work_graph_task", { runId, taskId }).then((result) => { if (alive) setGraph(result as TaskGraph); }).catch(() => undefined);
    read();
    const timer = live ? setInterval(read, POLL_MS) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [rpc, runId, taskId, live]);
  if (!graph) return <p className="py-1 text-xs text-muted-foreground">{t("graphLoading")}</p>;
  const off = graph.stages.filter(isOff);
  return (
    <div className="space-y-1 py-1" data-testid="stage-steps">
      {graph.stages.filter((block) => !isOff(block)).map((block) => (
        <div key={block.cell.stageId} className="flex min-w-0 items-start gap-2 text-xs" data-testid={`step-${block.cell.stageId}`}>
          <StageStrip cells={[block.cell]} testId={`step-cell-${block.cell.stageId}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-medium text-foreground">{stageName(block.cell.stageId)}</span>
              <span className="text-muted-foreground">{stageState(block.cell.state)}</span>
            </div>
            {block.rows.map((row, index) => {
              const parts = [roleName(row.role), row.role === "code" ? null : shortModel(row.model), row.turns !== null ? `${t("graphTurns").toLowerCase()} ${row.turns}` : null,
                row.seconds !== null ? duration(row.seconds, locale) : null, costText(row)].filter(Boolean);
              return (
                <div key={`${row.threadId ?? "code"}:${row.round}:${index}`} className="flex min-w-0 items-center gap-1 text-muted-foreground">
                  <span className="min-w-0 truncate">{block.rows.length > 1 ? `#${row.round} · ` : ""}{parts.join(" · ")}</span>
                  {row.threadId ? <button type="button" title={t("graphOpenThread")} aria-label={t("graphOpenThread")} className="shrink-0 rounded px-1 leading-none hover:bg-state-hover hover:text-foreground" onClick={() => navigate.toThread(row.threadId!)}>↗</button> : null}
                </div>
              );
            })}
            {block.cell.state === "failed" && block.cell.reason ? <div className="break-words text-destructive/90">{block.cell.reason}</div> : null}
          </div>
        </div>
      ))}
      {off.length ? <p className="text-xs text-muted-foreground">{fill("graphOff", { stages: off.map((block) => stageName(block.cell.stageId)).join(", ") })}</p> : null}
    </div>
  );
}
