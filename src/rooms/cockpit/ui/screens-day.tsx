import { useEffect, useRef, useState } from "react";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { Badge, Button, Disclosure } from "@lane-pilot/ui-kit";
import { Loaded, Panel, RefreshButton, day, fill, useLoad, type Rpc } from "./kit";

type FeedRow = { at: number; kind: string; text: string; runId?: string; taskId?: string; title?: string | null };
type Today = { kpi: { accepted: number; blocked: number; running: number; tokens: number; actions: number }; feed: FeedRow[]; partial?: string[] };

const FEED_POLL_MS = 8_000;
const FRESH_MS = 5_000;
const KIND_WORDS: Record<string, I18nKey> = { task_accepted: "ckKind_accepted", task_blocked: "ckKind_blocked", task_running: "ckKind_running" };
/** The feed kind in the person's words: «принято», «стоит», «идёт» — not task_accepted. */
const kindWord = (kind: string) => KIND_WORDS[kind] ? t(KIND_WORDS[kind]!) : kind.replace(/^(task|phase)_/, "");
const rowKey = (row: FeedRow) => `${row.at}-${row.kind}-${row.text}`;

/** Today: the day KPI strip, the live day feed, and the work done today unfolded — each accepted row opens its details on press. */
export function TodayScreen({ rpc, projectId }: { rpc: Rpc; projectId: string }) {
  const today = useLoad(() => rpc.call("cockpit_today", { projectId }) as Promise<Today>, [projectId], FEED_POLL_MS);
  // A row that arrived since the last read is marked for a few seconds (SMA live stream).
  const known = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!today.data) return;
    const keys = today.data.feed.map(rowKey);
    const next = new Set(known.current.size ? keys.filter((key) => !known.current.has(key)) : []);
    known.current = new Set(keys);
    if (next.size) {
      setFresh(next);
      const timer = setTimeout(() => setFresh(new Set()), FRESH_MS);
      return () => clearTimeout(timer);
    }
  }, [today.data]);
  return (
    <Panel title={t("ckScreen_today")} testId="ck-today" actions={<RefreshButton onClick={today.reload} />}>
      <Loaded state={today}>{(data) => (
        <div className="space-y-3">
          {(data.partial?.length ?? 0) ? <p className="text-xs text-muted-foreground" data-testid="ck-partial">{t("ckPartialNote")}: {data.partial!.join(", ")}</p> : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="ck-kpi">
            {([["ckKpiAccepted", data.kpi.accepted], ["ckKpiBlocked", data.kpi.blocked], ["ckKpiRunning", data.kpi.running], ["ckKpiTokens", data.kpi.tokens.toLocaleString()], ["ckKpiActions", data.kpi.actions]] as const).map(([key, value]) => (
              <div key={key} className="rounded-md border border-border p-2"><div className="text-xs text-muted-foreground">{t(key)}</div><div className="text-lg font-semibold tabular-nums">{value}</div></div>
            ))}
          </div>
          <div><h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("ckUnfoldDone")}</h4>
            <ul className="space-y-1 text-sm">{data.feed.filter((row) => row.kind === "task_accepted").map((row) => <AcceptedRow key={rowKey(row)} rpc={rpc} row={row} />)}</ul>
          </div>
          <div><h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("ckDayFeed")}</h4>
            {!data.feed.length ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
              <ul className="space-y-1 text-sm" data-testid="ck-feed">{data.feed.slice(0, 80).map((row) => <li key={rowKey(row)} className="flex min-w-0 gap-2"><span className="shrink-0 tabular-nums text-muted-foreground">{day(row.at)}</span><Badge variant="outline" className="shrink-0">{kindWord(row.kind)}</Badge>{fresh.has(rowKey(row)) ? <Badge variant="default" className="shrink-0">{t("ckNew")}</Badge> : null}<span className="min-w-0 truncate">{row.text}</span></li>)}</ul>
            )}
          </div>
        </div>
      )}</Loaded>
    </Panel>
  );
}

type AcceptanceCard = { contract: { objective: string | null; acceptance: string[] }; planFact: { items: Array<{ item: number; acceptance: string; verdict: string; why: string | null }> } | null };

/** One accepted row of «Сделано сегодня»: on press it loads the task's acceptance card — what was promised, what was checked, why accepted. */
function AcceptedRow({ rpc, row }: { rpc: Rpc; row: FeedRow }) {
  const [open, setOpen] = useState(false);
  const card = useLoad(() => (open && row.runId && row.taskId ? rpc.call("task_acceptance_card", { runId: row.runId, taskId: row.taskId }) as Promise<AcceptanceCard | null> : Promise.resolve(undefined)), [open, row.runId, row.taskId]);
  return (
    <li className="rounded border border-border/60 px-2 py-1">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>✓</span><span className="tabular-nums text-muted-foreground">{day(row.at)}</span><span className="min-w-0 flex-1 truncate">{row.title ?? row.text}</span>
      </button>
      {open ? (
        <div className="mt-1 text-xs" data-testid="ck-accepted-card">
          <Loaded state={{ data: card.data === undefined ? null : card.data, error: card.error, loading: card.loading }}>{(result) => !result ? <p className="text-muted-foreground">{t("ckEmpty")}</p> : (
            <div className="space-y-1">
              {result.contract.objective ? <p><span className="font-medium">{t("ckPromised")}:</span> {result.contract.objective}</p> : null}
              <ul>{(result.planFact?.items.length ? result.planFact.items.map((item) => ({ key: item.item, text: item.acceptance, verdict: item.verdict, why: item.why }))
                  : result.contract.acceptance.map((text, index) => ({ key: index, text, verdict: "no_row", why: null }))).map((item) => (
                <li key={item.key}>{item.verdict === "proven" ? "✓" : "·"} {item.text}{item.why ? ` — ${item.why}` : ""}</li>))}</ul>
            </div>
          )}</Loaded>
        </div>
      ) : null}
    </li>
  );
}

type MoneyStatus = { monthUsd: number; estimatedUsd?: number; cap: number | null; left: number | null; byProvider?: Record<string, number>; table?: Array<{ day: string; usd: number; byProvider: Record<string, number> }> };
type Windows = { at: string | null; windows: Record<string, { utilization: number; resetsAt: string | null }>; limitEventAt?: string };

/** Money: what the month cost on paid lanes, the money cap dialog, the subscription window bars, the accounts. */
export function MoneyScreen({ rpc, hostId }: { rpc: Rpc; hostId: string | null }) {
  const money = useLoad(() => rpc.call("money_status", {}) as Promise<MoneyStatus>, []);
  const windows = useLoad(() => (hostId ? rpc.call("cockpit_windows", { hostId }) as Promise<Windows> : Promise.resolve({ at: null, windows: {} })), [hostId]);
  const [cap, setCap] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const saveCap = async () => {
    // Compare-and-swap on the setting's version: a conflict answers with the version there is, and the save goes once more on it.
    // «unlimited» is the explicit no-cap value (capOf reads it as Infinity); anything else is a dollar number.
    const save = (expectedVersion: number) => rpc.call("save_setting", { projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "money.monthly_cap_usd", value: cap.trim() === "unlimited" ? "unlimited" : Number(cap), expectedVersion });
    let answer: { ok?: boolean; conflict?: boolean; version?: number } | { ok: false; error: string } = await save(0).catch((cause: unknown) => ({ ok: false as const, error: String(cause) }));
    if ("conflict" in answer && answer.conflict && typeof answer.version === "number") answer = await save(answer.version).catch((cause: unknown) => ({ ok: false as const, error: String(cause) }));
    setSaved((answer as { ok?: boolean }).ok ? t("ckSent") : JSON.stringify(answer).slice(0, 200));
    money.reload();
  };
  return (
    <div className="space-y-4">
      <Panel title={t("ckScreen_money")} testId="ck-money" actions={<RefreshButton onClick={money.reload} />}>
        <Loaded state={money}>{(m) => {
          // The spend table: one row per day of the last 14, one column per provider lane (the account spend has).
          const providers = [...new Set((m.table ?? []).flatMap((row) => Object.keys(row.byProvider)))].sort();
          const days = (m.table ?? []).filter((row) => row.usd > 0 || Object.keys(row.byProvider).length);
          return (
          <div className="space-y-2 text-sm">
            <p className="text-lg font-semibold">{fill("ckMoneyMonth", { v: m.monthUsd.toFixed(2) })}{m.cap !== null ? ` / $${m.cap}` : ""}</p>
            {(m.estimatedUsd ?? 0) > 0 ? <p className="text-xs text-muted-foreground">{fill("ckMoneyEstimated", { v: (m.estimatedUsd ?? 0).toFixed(2) })}</p> : null}
            {m.byProvider ? <ul className="text-xs text-muted-foreground">{Object.entries(m.byProvider).map(([provider, usd]) => <li key={provider}>{provider}: ${Number(usd).toFixed(2)}</li>)}</ul> : null}
            {days.length ? (
              <div className="overflow-x-auto" data-testid="ck-money-table">
                <table className="w-full text-xs"><thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">{t("ckMoneyDay")}</th>{providers.map((provider) => <th key={provider} className="py-1 pr-2">{provider}</th>)}<th className="py-1 pr-2">{t("ckMoneyTotal")}</th></tr></thead>
                  <tbody>{days.map((row) => <tr key={row.day} className="border-t border-border/60"><td className="py-1 pr-2">{row.day}</td>{providers.map((provider) => <td key={provider} className="py-1 pr-2">{row.byProvider[provider] ? `$${row.byProvider[provider].toFixed(2)}` : "·"}</td>)}<td className="py-1 pr-2">${row.usd.toFixed(2)}</td></tr>)}</tbody>
                </table>
              </div>
            ) : null}
            {/* The money cap dialog: the monthly cap of paid lanes, saved as the global setting money.monthly_cap_usd; «unlimited» means no cap on purpose. */}
            <div className="flex flex-wrap items-end gap-2" data-testid="ck-money-cap">
              <label className="text-xs text-muted-foreground">{t("ckMoneyCap")}<input className="mt-1 block w-28 rounded border border-border bg-background px-2 py-1 text-base sm:text-sm" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder={m.cap !== null ? String(m.cap) : "50"} /></label>
              <Button size="sm" disabled={!cap || (cap.trim() !== "unlimited" && Number.isNaN(Number(cap)))} onClick={() => void saveCap()}>{t("ckMoneyCapSave")}</Button>
              {saved ? <span className="text-xs text-muted-foreground">{saved}</span> : null}
            </div>
          </div>
          );
        }}</Loaded>
      </Panel>
      <Panel title={t("ckWindows")} testId="ck-windows">
        <Loaded state={windows}>{(w) => !Object.keys(w.windows).length ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
          <div className="space-y-2">
            {w.limitEventAt ? <p className="text-xs text-muted-foreground">{fill("ckWindowsFromEvent", { t: new Date(w.limitEventAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</p> : null}
            {Object.entries(w.windows).map(([name, window]) => (
            <div key={name} data-testid={`ck-window-${name}`}>
              <div className="flex justify-between text-xs"><span>{name}</span><span className="tabular-nums">{Math.round(window.utilization)}%{window.resetsAt ? ` · ${new Date(window.resetsAt).toLocaleString()}` : ""}</span></div>
              <div className="h-2 overflow-hidden rounded bg-muted"><div className={`h-full ${window.utilization >= 98 ? "bg-destructive" : window.utilization >= 80 ? "bg-amber-500" : "bg-primary"}`} style={{ width: `${Math.min(100, window.utilization)}%` }} /></div>
            </div>
          ))}</div>
        )}</Loaded>
      </Panel>
      <Panel title={t("ckAccounts")} testId="ck-accounts">
        <AccountList rpc={rpc} />
        <p className="mt-2 text-xs text-muted-foreground">{t("ckAddAccount")}</p>
      </Panel>
    </div>
  );
}

type Account = { hostId: string; name: string | null; at: string | null; windows: Record<string, { utilization: number }> | null; reason: string | null };
const WINDOW_WORDS: Record<string, string> = { five_hour: "5 часов", seven_day: "7 дней", seven_day_opus: "7 дней Opus" };

/** The accounts panel (SMA accounts, terminal window): one line per online machine — the subscription its terminal's statusline spends. */
function AccountList({ rpc }: { rpc: Rpc }) {
  const accounts = useLoad(() => rpc.call("cockpit_accounts", {}) as Promise<Account[]>, []);
  return (
    <Loaded state={accounts}>{(rows) => !rows.length ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
      <ul className="space-y-1 text-sm" data-testid="ck-account-list">{rows.map((row) => (
        <li key={row.hostId}>
          {row.windows
            ? fill("ckTerminalWindow", { m: row.name ?? row.hostId, w: Object.entries(row.windows).map(([name, window]) => `${WINDOW_WORDS[name] ?? name} ${Math.round(window.utilization)}%`).join(", ") })
            : fill("ckTerminalNoData", { m: row.name ?? row.hostId })}
        </li>
      ))}</ul>
    )}</Loaded>
  );
}

type WorkerDay = { day: string; tokens: number; done?: number; notDone?: number };
type Worker = { providerId: string; model: string; tokens: number; days: WorkerDay[]; capabilities: Array<{ capability: string; state: string; version: string }>; running: number; runningTasks: string[]; lastAt: number | null };
type Designer = { ratios: Record<string, number | null>; conditions: Array<{ id: string; ok: boolean; detail: string }>; readiness: string };

/** Workers: each worker's card with its 30-day history, the lane table of capability cells, and the designer's statistics. */
export function WorkersScreen({ rpc, projectId, hostId }: { rpc: Rpc; projectId: string; hostId: string | null }) {
  const workers = useLoad(() => rpc.call("cockpit_workers", { projectId }) as Promise<Worker[]>, [projectId]);
  // The subscription windows of this machine's claude-code account (the same read the Money screen draws, SMA m_sw_worker_card).
  const windows = useLoad(() => (hostId ? rpc.call("cockpit_windows", { hostId }) as Promise<Windows> : Promise.resolve({ at: null, windows: {} })), [hostId]);
  const designer = useLoad(() => rpc.call("cockpit_designer", { projectId }) as Promise<Designer>, [projectId]);
  const capabilities = ["answers", "documentary.nested", "documentary.role", "documentary.hooks", "documentary.session_end", "pause", "accounting", "progress", "gate"];
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
                {(worker.running > 0 || worker.lastAt) && <p className="text-xs" data-testid="ck-worker-presence">{worker.running > 0 ? fill("ckWorkerRunning", { n: String(worker.running), tasks: worker.runningTasks.join(", ") }) : ""}{worker.lastAt ? ` · ${day(worker.lastAt)}` : ""}</p>}
                {worker.providerId === "claude-code" && windows.data && Object.keys(windows.data.windows).length ? (
                  <p className="text-xs text-muted-foreground" data-testid="ck-worker-window">{Object.entries(windows.data.windows).map(([name, window]) => `${WINDOW_WORDS[name] ?? name} ${Math.round(window.utilization)}%`).join(" · ")}</p>
                ) : null}
                {/* Worker history: tokens per day over 30 days. */}
                <div className="mt-1 flex h-8 items-end gap-px" aria-hidden>{worker.days.map((row) => <div key={row.day} className="flex-1 bg-primary/60" style={{ height: `${Math.max(4, (row.tokens / peak) * 100)}%` }} title={`${row.day}: ${row.tokens} tok, ${row.done ?? 0} done, ${row.notDone ?? 0} not done`} />)}</div>
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
