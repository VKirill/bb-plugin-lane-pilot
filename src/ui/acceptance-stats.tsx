import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { Button } from "@lane-pilot/ui-kit";

type Totals = {
  dispatched:number; firstTryAccepted:number; eventuallyAccepted:number;
  attempts:number; attemptsPerAccepted:number|null;
  redispatched:number; families:number; causes:Record<string, number>;
};
type Week = Totals & { week:string };
type Stats = { days:number; totals:Totals; projects:Array<{ projectId:string; totals:Totals; weeks:Week[] }> };

const pct = (part:number, whole:number) => whole ? `${Math.round(100 * part / whole)}%` : "—";
const num = (value:number | null, suffix = "") => value === null ? "—" : `${value}${suffix}`;

/** Russian labels live here: i18n.ts is outside this lane's owns_paths. */
const CAUSE_LABEL:Record<string, string> = {
  ownership_dirt:"владение/грязь",
  outputs_empty:"пустой вывод",
  verification:"верификация",
  needs_human:"needs_human",
  merge:"merge",
  provider_limit:"провайдер/лимит",
  harness:"harness",
  other:"прочее",
};

const topCauses = (causes:Record<string, number>) => Object.entries(causes)
  .sort(([, a], [, b]) => b - a).slice(0, 3)
  .map(([cause, count]) => `${CAUSE_LABEL[cause] ?? cause} ×${count}`).join(", ") || "—";

/** «Принятие с первой попытки»: per ISO week, how many tasks landed first try, eventually, or were sent again — and why attempts failed. */
export function AcceptanceStats({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [days, setDays] = useState(28);
  const [data, setData] = useState<Stats | null>(null);
  const load = useCallback(async () => {
    try { setData(await rpc.call("acceptance_stats", { projectId, days }) as Stats); } catch { setData(null); }
  }, [projectId, days, rpc]);
  useEffect(() => { void load(); }, [load]);

  const project = data?.projects.find((row) => row.projectId === projectId) ?? null;
  const rows = project?.weeks ?? [];
  return (
    <div className="max-w-xl space-y-2" data-testid="acceptance-stats">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Принятие с первой попытки</p>
        {[7, 28].map((value) => (
          <Button key={value} size="sm" variant={days === value ? "secondary" : "ghost"} className="h-6 px-2 text-xs"
            data-testid={`acceptance-stats-days-${value}`} onClick={() => setDays(value)}>{value === 7 ? "7 дней" : "28 дней"}</Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">По задачам проекта за неделю: сколько принято с первой попытки, сколько в итоге, сколько отправлено заново и из-за чего падали попытки.</p>
      {!data || rows.length === 0 ? <p className="text-xs text-muted-foreground">За этот период задач нет.</p> : (
        <table className="w-full text-xs" data-testid="acceptance-stats-table">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pr-2 font-medium">Неделя</th>
              <th className="pr-2 text-right font-medium">Задач</th>
              <th className="pr-2 text-right font-medium">С первой попытки</th>
              <th className="pr-2 text-right font-medium">В итоге</th>
              <th className="pr-2 text-right font-medium">Повторно</th>
              <th className="font-medium">Топ причин падений</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.week} className="border-t border-border/60" data-testid={`acceptance-stats-week-${row.week}`}>
                <td className="pr-2 py-1">{row.week}</td>
                <td className="pr-2 py-1 text-right">{row.dispatched}</td>
                <td className="pr-2 py-1 text-right">{pct(row.firstTryAccepted, row.dispatched)}</td>
                <td className="pr-2 py-1 text-right">{pct(row.eventuallyAccepted, row.dispatched)}</td>
                <td className="pr-2 py-1 text-right">{pct(row.redispatched, row.dispatched)}</td>
                <td className="py-1" style={{ overflowWrap:"anywhere" }}>{topCauses(row.causes)}</td>
              </tr>
            ))}
            <tr className="border-t border-border/60 font-medium" data-testid="acceptance-stats-total">
              <td className="pr-2 py-1">Итого</td>
              <td className="pr-2 py-1 text-right">{project!.totals.dispatched}</td>
              <td className="pr-2 py-1 text-right">{pct(project!.totals.firstTryAccepted, project!.totals.dispatched)}</td>
              <td className="pr-2 py-1 text-right">{pct(project!.totals.eventuallyAccepted, project!.totals.dispatched)}</td>
              <td className="pr-2 py-1 text-right">{pct(project!.totals.redispatched, project!.totals.dispatched)}</td>
              <td className="py-1" style={{ overflowWrap:"anywhere" }}>
                {topCauses(project!.totals.causes)}; попыток на принятую задачу: {num(project!.totals.attemptsPerAccepted)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
