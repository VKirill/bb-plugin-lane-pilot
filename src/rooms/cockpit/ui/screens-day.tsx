import { useState } from "react";
import { t } from "@lane-pilot/i18n";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { Badge, Button, Disclosure } from "@lane-pilot/ui-kit";
import { Loaded, Panel, RefreshButton, day, fill, useLoad, type Rpc } from "./kit";

type Today = { kpi: { accepted: number; blocked: number; running: number; tokens: number; actions: number }; feed: Array<{ at: number; kind: string; text: string }> };

/** Today: the day KPI strip, the day feed, and the work done today unfolded. */
export function TodayScreen({ rpc, projectId }: { rpc: Rpc; projectId: string }) {
  const today = useLoad(() => rpc.call("cockpit_today", { projectId }) as Promise<Today>, [projectId]);
  return (
    <Panel title={t("ckScreen_today")} testId="ck-today" actions={<RefreshButton onClick={today.reload} />}>
      <Loaded state={today}>{(data) => (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="ck-kpi">
            {([["ckKpiAccepted", data.kpi.accepted], ["ckKpiBlocked", data.kpi.blocked], ["ckKpiRunning", data.kpi.running], ["ckKpiTokens", data.kpi.tokens.toLocaleString()], ["ckKpiActions", data.kpi.actions]] as const).map(([key, value]) => (
              <div key={key} className="rounded-md border border-border p-2"><div className="text-xs text-muted-foreground">{t(key)}</div><div className="text-lg font-semibold tabular-nums">{value}</div></div>
            ))}
          </div>
          <Disclosure summary={t("ckUnfoldDone")} testId="ck-done">
            <ul className="space-y-1 text-sm">{data.feed.filter((row) => row.kind === "task_accepted").map((row) => <li key={`${row.at}-${row.text}`}>✓ {day(row.at)} {row.text}</li>)}</ul>
          </Disclosure>
          <div><h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("ckDayFeed")}</h4>
            {!data.feed.length ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
              <ul className="space-y-1 text-sm" data-testid="ck-feed">{data.feed.slice(0, 80).map((row) => <li key={`${row.at}-${row.kind}-${row.text}`} className="flex min-w-0 gap-2"><span className="shrink-0 tabular-nums text-muted-foreground">{day(row.at)}</span><Badge variant="outline" className="shrink-0">{row.kind.replace(/^(task|phase)_/, "")}</Badge><span className="min-w-0 truncate">{row.text}</span></li>)}</ul>
            )}
          </div>
        </div>
      )}</Loaded>
    </Panel>
  );
}

type MoneyStatus = { monthUsd: number; cap: number | null; left: number | null; byProvider?: Record<string, number>; days?: Array<{ day: string; usd: number }> };
type Windows = { at: string | null; windows: Record<string, { utilization: number; resetsAt: string | null }> };

/** Money: what the month cost on paid lanes, the money cap dialog, the subscription window bars, the accounts. */
export function MoneyScreen({ rpc, hostId }: { rpc: Rpc; hostId: string | null }) {
  const money = useLoad(() => rpc.call("money_status", {}) as Promise<MoneyStatus>, []);
  const windows = useLoad(() => (hostId ? rpc.call("cockpit_windows", { hostId }) as Promise<Windows> : Promise.resolve({ at: null, windows: {} })), [hostId]);
  const [cap, setCap] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const saveCap = async () => {
    // Compare-and-swap on the setting's version: a conflict answers with the version there is, and the save goes once more on it.
    const save = (expectedVersion: number) => rpc.call("save_setting", { projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "money.monthly_cap_usd", value: Number(cap), expectedVersion });
    let answer: { ok?: boolean; conflict?: boolean; version?: number } | { ok: false; error: string } = await save(0).catch((cause: unknown) => ({ ok: false as const, error: String(cause) }));
    if ("conflict" in answer && answer.conflict && typeof answer.version === "number") answer = await save(answer.version).catch((cause: unknown) => ({ ok: false as const, error: String(cause) }));
    setSaved((answer as { ok?: boolean }).ok ? t("ckSent") : JSON.stringify(answer).slice(0, 200));
    money.reload();
  };
  return (
    <div className="space-y-4">
      <Panel title={t("ckScreen_money")} testId="ck-money" actions={<RefreshButton onClick={money.reload} />}>
        <Loaded state={money}>{(m) => (
          <div className="space-y-2 text-sm">
            <p className="text-lg font-semibold">{fill("ckMoneyMonth", { v: m.monthUsd.toFixed(2) })}{m.cap !== null ? ` / $${m.cap}` : ""}</p>
            {m.byProvider ? <ul className="text-xs text-muted-foreground">{Object.entries(m.byProvider).map(([provider, usd]) => <li key={provider}>{provider}: ${Number(usd).toFixed(2)}</li>)}</ul> : null}
            {/* The money cap dialog: the monthly cap of paid lanes, saved as the global setting money.monthly_cap_usd. */}
            <div className="flex flex-wrap items-end gap-2" data-testid="ck-money-cap">
              <label className="text-xs text-muted-foreground">{t("ckMoneyCap")}<input className="mt-1 block w-28 rounded border border-border bg-background px-2 py-1 text-base sm:text-sm" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder={m.cap !== null ? String(m.cap) : "50"} /></label>
              <Button size="sm" disabled={!cap || Number.isNaN(Number(cap))} onClick={() => void saveCap()}>{t("ckMoneyCapSave")}</Button>
              {saved ? <span className="text-xs text-muted-foreground">{saved}</span> : null}
            </div>
          </div>
        )}</Loaded>
      </Panel>
      <Panel title={t("ckWindows")} testId="ck-windows">
        <Loaded state={windows}>{(w) => !Object.keys(w.windows).length ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
          <div className="space-y-2">{Object.entries(w.windows).map(([name, window]) => (
            <div key={name} data-testid={`ck-window-${name}`}>
              <div className="flex justify-between text-xs"><span>{name}</span><span className="tabular-nums">{Math.round(window.utilization)}%{window.resetsAt ? ` · ${new Date(window.resetsAt).toLocaleString()}` : ""}</span></div>
              <div className="h-2 overflow-hidden rounded bg-muted"><div className={`h-full ${window.utilization >= 98 ? "bg-destructive" : window.utilization >= 80 ? "bg-amber-500" : "bg-primary"}`} style={{ width: `${Math.min(100, window.utilization)}%` }} /></div>
            </div>
          ))}</div>
        )}</Loaded>
      </Panel>
      <Panel title={t("ckAccounts")} testId="ck-accounts"><p className="text-sm text-muted-foreground">{t("ckAddAccount")}</p></Panel>
    </div>
  );
}

type Worker = { providerId: string; model: string; tokens: number; days: Array<{ day: string; tokens: number }>; capabilities: Array<{ capability: string; state: string; version: string }> };
type Designer = { ratios: Record<string, number | null>; conditions: Array<{ id: string; ok: boolean; detail: string }>; readiness: string };

/** Workers: each worker's card with its 30-day history, the lane table of capability cells, and the designer's statistics. */
export function WorkersScreen({ rpc, projectId }: { rpc: Rpc; projectId: string }) {
  const workers = useLoad(() => rpc.call("cockpit_workers", { projectId }) as Promise<Worker[]>, [projectId]);
  const designer = useLoad(() => rpc.call("cockpit_designer", { projectId }) as Promise<Designer>, [projectId]);
  const capabilities = ["answers", "documentary", "pause"];
  return (
    <div className="space-y-4">
      <Panel title={t("ckScreen_workers")} testId="ck-workers" actions={<RefreshButton onClick={workers.reload} />}>
        <Loaded state={workers}>{(rows) => !rows.length ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
          <div className="grid gap-2 sm:grid-cols-2">{rows.map((worker) => {
            const peak = Math.max(1, ...worker.days.map((row) => row.tokens));
            return (
              <div key={`${worker.providerId}/${worker.model}`} className="rounded-md border border-border p-2" data-testid="ck-worker-card">
                <p className="truncate text-sm font-medium">{worker.model}</p>
                <p className="text-xs text-muted-foreground">{worker.providerId} · {fill("ckWorkerTokens", { v: worker.tokens.toLocaleString() })}</p>
                {/* Worker history: tokens per day over 30 days. */}
                <div className="mt-1 flex h-8 items-end gap-px" aria-hidden>{worker.days.map((row) => <div key={row.day} className="flex-1 bg-primary/60" style={{ height: `${Math.max(4, (row.tokens / peak) * 100)}%` }} title={`${row.day}: ${row.tokens}`} />)}</div>
              </div>
            );
          })}</div>
        )}</Loaded>
      </Panel>
      <Panel title={t("ckLanes")} testId="ck-lanes">
        <Loaded state={workers}>{(rows) => (
          <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">provider</th>{capabilities.map((name) => <th key={name} className="py-1 pr-2">{name}</th>)}</tr></thead>
            <tbody>{[...new Set(rows.map((row) => row.providerId))].map((provider) => {
              const cells = rows.find((row) => row.providerId === provider)?.capabilities ?? [];
              return <tr key={provider} className="border-t border-border/60"><td className="py-1 pr-2">{provider}</td>{capabilities.map((name) => { const cell = cells.find((row) => row.capability === name); return <td key={name} className="py-1 pr-2">{cell ? (cell.state === "supported" ? "✓" : "✗") : "·"}</td>; })}</tr>;
            })}</tbody></table></div>
        )}</Loaded>
      </Panel>
      <Panel title={t("ckDesigner")} testId="ck-designer">
        <Loaded state={designer}>{(d) => (
          <div className="space-y-2 text-sm">
            <p>{d.readiness}</p>
            <ul className="text-xs">{d.conditions.map((row) => <li key={row.id}>{row.ok ? "✓" : "✗"} {row.detail}</li>)}</ul>
            <p className="text-xs text-muted-foreground">{Object.entries(d.ratios).map(([key, value]) => `${key}: ${value ?? "—"}`).join(" · ")}</p>
          </div>
        )}</Loaded>
      </Panel>
    </div>
  );
}
