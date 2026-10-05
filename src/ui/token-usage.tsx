import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Surface, SurfaceBody, SurfaceHeader } from "./surface";

type Range = "7d" | "14d" | "30d" | "month";
type ModelRow = { providerId: string; model: string; input: number; output: number; cached: number; total: number };
type SeriesDay = { day: string; models: Array<{ providerId: string; model: string; total: number }> };
type Diagnostics = { threadsSeen: number; threadsWithUsage: number; threadsFailed: number; lastError: string | null };
type Payload = { byModel: ModelRow[]; series: SeriesDay[]; months: string[]; lastSyncAt: number | null; noDataProviders: string[]; diagnostics: Diagnostics };

const RANGES: Range[] = ["7d", "14d", "30d", "month"];
const fmt = (value: number) => value.toLocaleString();
const hue = (index: number) => `oklch(0.62 0.12 ${index * 47})`;

function currentMonth(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

export function TokenUsage({ projectId }: { projectId?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [range, setRange] = useState<Range>("7d");
  const [month, setMonth] = useState(currentMonth);
  const [data, setData] = useState<Payload | null>(null);
  const [syncing, setSyncing] = useState(false);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const request = useCallback(() => rpc.call("token_usage", {
    range, ...(range === "month" ? { month } : {}), ...(projectId ? { projectId } : {}),
  }) as Promise<Payload>, [projectId, range, month, rpc]);
  const load = useCallback(async () => {
    const forProject = projectId;
    try {
      const next = await request();
      if (forProject === projectRef.current) setData(next);
    } catch { if (forProject === projectRef.current) setData(null); }
  }, [projectId, request]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const refresh = async () => {
    setSyncing(true);
    try {
      await rpc.call("token_usage_sync", {});
      const started = Date.now();
      for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const next = await request();
        setData(next);
        if (next.lastSyncAt && next.lastSyncAt >= started - 2_000) break;
      }
    } catch { await load(); } finally { setSyncing(false); }
  };

  const months = [...new Set([...(data?.months ?? []), month])].sort().reverse();
  const chartMax = Math.max(1, ...(data?.series ?? []).map((day) => day.models.reduce((sum, row) => sum + row.total, 0)));
  const lastSync = data?.lastSyncAt
    ? t("tokenUsageLastSync").replace("{time}", new Date(data.lastSyncAt).toLocaleString())
    : t("tokenUsageNeverSynced");
  const syncStats = data
    ? t("tokenUsageSyncStats")
      .replace("{seen}", String(data.diagnostics.threadsSeen))
      .replace("{withUsage}", String(data.diagnostics.threadsWithUsage))
      .replace("{failed}", String(data.diagnostics.threadsFailed))
    : "";
  const lastError = data?.diagnostics.lastError
    ? t("tokenUsageLastError").replace("{error}", data.diagnostics.lastError)
    : "";

  return (
    <div className="space-y-4" data-testid="token-usage">
      <Surface testId="token-usage-panel">
        <SurfaceHeader className="justify-between">
          <h2 className="text-sm font-medium">{t("tabTokens")}</h2>
          <Button size="sm" variant="outline" disabled={syncing} data-testid="token-usage-refresh" onClick={() => void refresh()}>{t("reload")}</Button>
        </SurfaceHeader>
        <SurfaceBody>
          <p className="max-w-xl text-xs text-muted-foreground">{t("tokenUsageHelp")}</p>
          <div className="flex flex-wrap items-center gap-2">
            {RANGES.map((value) => (
              <Button key={value} size="sm" variant={range === value ? "secondary" : "ghost"} className="h-6 px-2 text-xs"
                data-testid={`token-usage-range-${value}`} onClick={() => setRange(value)}>
                {value === "month" ? t("tokenUsageMonth") : t("criticValueDays").replace("{n}", value === "7d" ? "7" : value === "14d" ? "14" : "30")}
              </Button>
            ))}
            {range === "month" ? (
              <Select value={month} onValueChange={setMonth}>
                <SelectTrigger className="h-6 w-32 px-2 text-xs" data-testid="token-usage-month" aria-label={t("tokenUsageMonth")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {months.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="token-usage-sync">
            {lastSync} · {t("tokenUsageUtc")}{syncStats ? ` · ${syncStats}` : ""}{lastError ? ` · ${lastError}` : ""}
          </p>
          {data?.noDataProviders.length ? (
            <p className="text-xs text-muted-foreground" data-testid="token-usage-no-data">
              {t("tokenUsageNoData").replace("{list}", data.noDataProviders.join(", "))}
            </p>
          ) : null}
          {!data || data.byModel.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="token-usage-empty">{t("tokenUsageEmpty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full caption-bottom text-xs" data-testid="token-usage-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-2 py-1.5 font-medium">{t("tokenUsageModel")}</th>
                    <th className="px-2 py-1.5 font-medium">{t("tokenUsageInput")}</th>
                    <th className="px-2 py-1.5 font-medium">{t("tokenUsageOutput")}</th>
                    <th className="px-2 py-1.5 font-medium">{t("tokenUsageCached")}</th>
                    <th className="px-2 py-1.5 font-medium">{t("tokenUsageTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((row) => (
                    <tr key={`${row.providerId}:${row.model}`} className="border-b" data-testid={`token-usage-row-${row.model}`}>
                      <td className="px-2 py-1.5">{row.providerId ? `${row.providerId} · ${row.model}` : row.model}</td>
                      <td className="px-2 py-1.5">{fmt(row.input)}</td>
                      <td className="px-2 py-1.5">{fmt(row.output)}</td>
                      <td className="px-2 py-1.5">{fmt(row.cached)}</td>
                      <td className="px-2 py-1.5 font-medium">{fmt(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && data.series.some((day) => day.models.some((row) => row.total > 0)) ? (
            <div className="space-y-1" data-testid="token-usage-chart">
              <p className="text-xs font-medium">{t("tokenUsageChart")}</p>
              <div className="flex items-end gap-px" style={{ minHeight: "4.5rem" }}>
                {data.series.map((day) => {
                  const sum = day.models.reduce((total, row) => total + row.total, 0);
                  return (
                    <div key={day.day} className="flex min-w-0 flex-1 flex-col justify-end" title={`${day.day}: ${fmt(sum)}`} data-testid={`token-usage-bar-${day.day}`}>
                      <div className="flex w-full flex-col-reverse overflow-hidden rounded-sm bg-[var(--lp-well)]" style={{ height: `${Math.max(sum ? 8 : 2, Math.round((sum / chartMax) * 72))}px` }}>
                        {day.models.map((row, index) => (
                          <div key={`${row.providerId}:${row.model}`} style={{ height: `${Math.max(1, Math.round((row.total / Math.max(sum, 1)) * 100))}%`, background: hue(index) }} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </SurfaceBody>
      </Surface>
    </div>
  );
}
