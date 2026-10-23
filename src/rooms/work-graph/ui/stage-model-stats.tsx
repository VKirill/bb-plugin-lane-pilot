import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import type { GraphStats } from "../logic";
import { duration, fill, money, percent, roleName, shortModel, stageName } from "./format";

type Stats = GraphStats & { days: number; capped: boolean };
const DAYS = [7, 30, 90] as const;
const th = "px-2 py-1.5 text-left font-medium";
const num = "px-2 py-1.5 text-right tabular-nums";

/** Over the period: how each stage fared, and how each model fared on each stage (the second table answers «which model where»). */
export function StageModelStats({ projectId, excludeProjectIds, locale }: { projectId?: string | undefined; excludeProjectIds?: readonly string[] | undefined; locale: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [days, setDays] = useState<number>(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const excluded = (excludeProjectIds ?? []).join(",");
  useEffect(() => {
    let alive = true;
    setStats(null);
    void rpc.call("work_graph_stats", { days, ...(projectId ? { projectId } : {}), ...(excluded ? { excludeProjectIds: excluded.split(",") } : {}) })
      .then((result) => { if (alive) setStats(result as Stats); }).catch(() => undefined);
    return () => { alive = false; };
  }, [rpc, days, projectId, excluded]);
  return (
    <div className="space-y-4" data-testid="stage-model-stats">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 max-w-3xl text-sm text-muted-foreground">{t("graphStatsHelp")}</p>
        <Select value={String(days)} onValueChange={(next) => setDays(Number(next))}>
          <SelectTrigger className="h-8 w-full sm:w-40" data-testid="graph-days"><SelectValue /></SelectTrigger>
          <SelectContent>{DAYS.map((n) => <SelectItem key={n} value={String(n)}>{fill("graphDays", { n })}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {stats === null ? <p className="text-sm text-muted-foreground">{t("graphLoading")}</p> : !stats.tasks ? <p className="text-sm text-muted-foreground">{t("graphEmpty")}</p> : (
        <>
          <p className="text-xs text-muted-foreground">{stats.capped ? fill("graphCapped", { n: stats.tasks }) : fill("graphTasks", { n: stats.tasks })}</p>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[44rem] text-xs" data-testid="graph-stage-table">
              <thead><tr className="border-b border-border text-muted-foreground">
                <th className={th}>{t("graphStage")}</th><th className={th}>{t("graphGreen")}</th><th className={th}>{t("graphRed")}</th><th className={th}>{t("graphUnknown")}</th>
                <th className={th}>{t("graphSkipped")}</th><th className={th}>{t("graphGreenShare")}</th><th className={th}>{t("graphMedianRounds")}</th>
                <th className={th}>{t("graphMedianCost")}</th><th className={th}>{t("graphMedianTime")}</th>
              </tr></thead>
              <tbody>
                {stats.stages.map((row) => (
                  <tr key={row.stageId} className="border-b border-border/60 last:border-b-0" data-testid={`graph-stat-${row.stageId}`}>
                    <td className="px-2 py-1.5">{stageName(row.stageId)}</td>
                    <td className={`${num} text-[var(--color-success,#16a34a)]`}>{row.green}</td>
                    <td className={`${num} ${row.red ? "text-destructive" : ""}`}>{row.red}</td>
                    <td className={num}>{row.unknown}</td>
                    <td className={`${num} text-muted-foreground`}>{row.skipped}</td>
                    <td className={num}>{percent(row.greenShare)}</td>
                    <td className={num}>{row.medianRounds ?? "—"}</td>
                    <td className={num}>{money(row.medianCostUsd)}</td>
                    <td className={num}>{duration(row.medianSeconds, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="text-sm font-semibold">{t("graphModelStage")}</h3>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[40rem] text-xs" data-testid="graph-model-table">
              <thead><tr className="border-b border-border text-muted-foreground">
                <th className={th}>{t("graphModel")}</th><th className={th}>{t("graphRole")}</th><th className={th}>{t("graphStage")}</th>
                <th className={th}>n</th><th className={th}>{t("graphShare")}</th><th className={th}>{t("graphMedianCost")}</th><th className={th}>{t("graphMedianTime")}</th>
              </tr></thead>
              <tbody>
                {stats.models.map((row) => (
                  <tr key={`${row.model}:${row.stageId}`} className="border-b border-border/60 last:border-b-0" data-testid={`graph-model-${row.stageId}`}>
                    <td className="px-2 py-1.5" title={row.model}>{shortModel(row.model)}</td>
                    <td className="px-2 py-1.5">{roleName(row.role)}</td>
                    <td className="px-2 py-1.5">{stageName(row.stageId)}</td>
                    <td className={num}>{row.n}</td>
                    <td className={num}>{fill(row.shareKind === "blocking" ? "graphShareBlocking" : "graphShareGreen", { v: percent(row.share) })}</td>
                    <td className={num}>{money(row.medianCostUsd)}</td>
                    <td className={num}>{duration(row.medianSeconds, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
