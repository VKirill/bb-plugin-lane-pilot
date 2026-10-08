import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import type { WriterReuseStats } from "../writer-reuse-stats";
import { t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";

const show = (value:number | null, suffix = "") => value === null ? "—" : `${value}${suffix}`;

/** Whether writers carry their context: cold sessions per accepted task, continued turns, time to acceptance. */
export function WriterReuse({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [days, setDays] = useState(7);
  const [data, setData] = useState<WriterReuseStats | null>(null);
  const load = useCallback(async () => {
    try { setData((await rpc.call("writer_reuse_stats", { projectId, days }) as { stats:WriterReuseStats }).stats); } catch { setData(null); }
  }, [projectId, days, rpc]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="max-w-xl space-y-2" data-testid="writer-reuse">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{t("writerReuseTitle")}</p>
        {[7, 30].map((value) => (
          <Button key={value} size="sm" variant={days === value ? "secondary" : "ghost"} className="h-6 px-2 text-xs"
            data-testid={`writer-reuse-days-${value}`} onClick={() => setDays(value)}>{t("criticValueDays").replace("{n}", String(value))}</Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("writerReuseHelp")}</p>
      {!data || data.tasks === 0 ? <p className="text-xs text-muted-foreground">{t("criticValueNone")}</p> : (
        <div className="space-y-1 rounded-md border border-border/60 p-2 text-xs" data-testid="writer-reuse-numbers">
          <p>{t("writerReuseTasks").replace("{tasks}", String(data.tasks)).replace("{accepted}", String(data.accepted)).replace("{minutes}", show(data.medianMinutesToAccept))}</p>
          <p>{t("writerReuseCold").replace("{cold}", String(data.coldThreads)).replace("{per}", show(data.coldPerAccepted)).replace("{continued}", String(data.continued))}</p>
          <p>{t("writerReuseArea").replace("{share}", show(data.areaShare, "%")).replace("{per}", show(data.tasksPerArea))}</p>
        </div>
      )}
    </div>
  );
}
