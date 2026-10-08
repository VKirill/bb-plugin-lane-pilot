import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Disclosure } from "@lane-pilot/ui-kit";

type Stats = { days:number; stats:Array<{
  stage:string; runs:number; approved:number; blocked:number; skipped:number; blockShare:number | null;
  afterBlock:{ fixedAndAccepted:number; sentAgainNotAccepted:number; dropped:number };
  missed:{ count:number; examples:Array<{ taskId:string; reason:string }> };
  firstTryAccepted:{ reviewed:{ tasks:number; share:number | null }; notReviewed:{ tasks:number; share:number | null } };
}> };

const STAGE_LABEL = { "plan-critique":"stagePlanCritique", "code-critique":"stageCodeCritique", "specialist-review":"criticSpecialist" } as const;
const pct = (value:number | null) => value === null ? "—" : `${value}%`;

/** Whether the critics pay for their time: how often they block, what a block led to, what they let through. */
export function CriticValue({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Stats | null>(null);
  const load = useCallback(async () => {
    try { setData(await rpc.call("critic_stats", { projectId, days }) as Stats); } catch { setData(null); }
  }, [projectId, days, rpc]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="max-w-xl space-y-2" data-testid="critic-value">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{t("criticValueTitle")}</p>
        {[7, 30].map((value) => (
          <Button key={value} size="sm" variant={days === value ? "secondary" : "ghost"} className="h-6 px-2 text-xs"
            data-testid={`critic-value-days-${value}`} onClick={() => setDays(value)}>{t("criticValueDays").replace("{n}", String(value))}</Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("criticValueHelp")}</p>
      {(data?.stats ?? []).map((row) => (
        <div key={row.stage} className="space-y-1 rounded-md border border-border/60 p-2 text-xs" data-testid={`critic-value-${row.stage}`}>
          <p className="font-medium">{row.stage in STAGE_LABEL ? t(STAGE_LABEL[row.stage as keyof typeof STAGE_LABEL]) : row.stage}</p>
          {row.runs === 0 ? <p className="text-muted-foreground">{row.skipped ? t("criticValueOnlySkipped").replace("{n}", String(row.skipped)) : t("criticValueNone")}</p> : <>
            <p>{t("criticValueRuns").replace("{runs}", String(row.runs)).replace("{blocked}", String(row.blocked)).replace("{share}", pct(row.blockShare)).replace("{skipped}", String(row.skipped))}</p>
            {row.blocked ? <p>{t("criticValueAfterBlock").replace("{fixed}", String(row.afterBlock.fixedAndAccepted)).replace("{again}", String(row.afterBlock.sentAgainNotAccepted)).replace("{dropped}", String(row.afterBlock.dropped))}</p> : null}
            <p>{t("criticValueFirstTry").replace("{reviewed}", pct(row.firstTryAccepted.reviewed.share)).replace("{rn}", String(row.firstTryAccepted.reviewed.tasks))
              .replace("{skipped}", pct(row.firstTryAccepted.notReviewed.share)).replace("{sn}", String(row.firstTryAccepted.notReviewed.tasks))}</p>
            {row.missed.count ? <Disclosure compact summary={t("criticValueMissed").replace("{n}", String(row.missed.count))}>
              <ul className="space-y-1 pt-1">{row.missed.examples.map((miss) => <li key={miss.taskId} style={{ overflowWrap:"anywhere" }}><b>{miss.taskId}</b>: {miss.reason}</li>)}</ul>
            </Disclosure> : <p className="text-muted-foreground">{t("criticValueNoMisses")}</p>}
          </>}
        </div>
      ))}
    </div>
  );
}
