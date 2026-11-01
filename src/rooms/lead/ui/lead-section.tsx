import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { t, type Locale } from "@lane-pilot/i18n";
import { Alert, AlertDescription, AlertTitle, Button, Disclosure, Skeleton } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import type { LeadState } from "../server/service";

/**
 * The «Штурман» section of the Self-improvement screen (roadmap WP6): the switch, the next and the last ticks, the road's counts, the open
 * proposals, the tier of every class with its exam numbers, the receipts of the last ticks; the settings fields come from the page
 * (the same save as every other setting). Every number here is a row: a tick's receipt, a branch of the tree, a row of the journal.
 */
type Tier = LeadState["rights"][number]["tier"];
const USD = 1_000_000;

function when(ms: number | null | undefined, locale: Locale): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
const pct = (value: number | null | undefined) => (value == null ? "—" : `${Math.round(value * 100)}%`);

function Tile({ title, value, meta, testId }: { title: string; value: string; meta?: string; testId: string }) {
  return (
    <div className="lp-card min-w-0 space-y-1 p-3" data-testid={testId}>
      <span className="block min-w-0 truncate text-xs text-muted-foreground">{title}</span>
      <div className="break-words text-sm font-medium">{value}</div>
      {meta ? <div className="break-words text-xs text-muted-foreground">{meta}</div> : null}
    </div>
  );
}

export function LeadSection({ locale, fields }: { locale: Locale; fields: ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<LeadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setState(await rpc.call("lead_state", {}) as LeadState); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);

  const act = async (name: string, run: () => Promise<string>) => {
    setBusy(name); setNotice(null);
    try { setNotice(await run()); } catch (cause) { setNotice(`${t("lead_failed")}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(null); await load(); }
  };
  const toggle = () => act("enable", async () => { await rpc.call("lead_set_enabled", { on: !state!.settings.enabled }); return state!.settings.enabled ? t("lead_turned_off") : t("lead_turned_on"); });
  const tickNow = () => act("tick", async () => { const r = await rpc.call("lead_tick_now", {}) as { ok: boolean; tickId?: string; reason?: string }; return r.ok ? `${t("lead_tick_started")} ${r.tickId}` : `${t("lead_tick_refused")}: ${r.reason}`; });
  const openChat = () => act("chat", async () => { const r = await rpc.call("lead_chat_start", {}); return `${r.reused ? t("lead_chat_reused") : t("lead_chat_opened")} @thread:${r.threadId}`; });
  const label = (id: string, verdict: "exact" | "partial" | "miss") => act(`label:${id}`, async () => { await rpc.call("lead_label", { id, label: verdict }); return `${t("lead_labelled")}: ${id} ${verdict}`; });

  if (error && !state) return <Alert variant="destructive"><AlertTitle>{t("lead_load_failed")}</AlertTitle><AlertDescription className="break-words">{error}</AlertDescription></Alert>;
  if (!state) return <div aria-busy="true" className="space-y-2" data-testid="lead-loading"><Skeleton className="h-20 w-full" /></div>;
  const last = state.ticks[0] ?? null;
  const tierLabel: Record<Tier, string> = { decides: t("lead_tier_decides"), proposes: t("lead_tier_proposes"), owner_only: t("lead_tier_owner_only") };
  return (
    <div className="min-w-0 space-y-4" data-testid="lead-section">
      <p className="max-w-2xl text-xs text-muted-foreground">{t("lead_help")}</p>
      <div className="grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4">
        <Tile testId="lead-tile-ticks" title={t("lead_tile_ticks")} value={state.settings.enabled ? t("lead_on") : t("lead_off")} meta={state.settings.enabled ? `${t("lead_next")}: ${when(state.nextTickAt, locale)}` : state.settings.tickCron} />
        <Tile testId="lead-tile-last" title={t("lead_tile_last")} value={last ? `${last.status} · ${when(last.started_at, locale)}` : "—"} meta={last ? `${t("lead_proposed")} ${JSON.parse(last.proposed_json ?? "[]").length}, $${((last.cost_micro_usd ?? 0) / USD).toFixed(2)}` : t("lead_no_tick")} />
        <Tile testId="lead-tile-road" title={t("lead_tile_road")} value={`${state.road.open ?? 0} · ${state.road.proposed ?? 0} · ${state.road.accepted ?? 0}`} meta={`${t("lead_road_meta")} · ${t("lead_waiting")}: ${state.proposalsOpen}`} />
        <Tile testId="lead-tile-journal" title={t("lead_tile_journal")} value={String(state.journal.total)} meta={`${t("lead_journal_exam")} ${state.journal.exam} · ${t("lead_journal_backtest")} ${state.journal.backtest}`} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant={state.settings.enabled ? "outline" : "default"} disabled={busy !== null} data-testid="lead-toggle" onClick={() => void toggle()}>{state.settings.enabled ? t("lead_btn_off") : t("lead_btn_on")}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy !== null || Boolean(state.running)} data-testid="lead-tick-now" onClick={() => void tickNow()}>{t("lead_btn_tick")}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} data-testid="lead-open-chat" onClick={() => void openChat()}>{t("lead_btn_chat")}</Button>
      </div>
      {notice ? <p className="break-words text-xs text-muted-foreground" data-testid="lead-notice">{notice}</p> : null}
      <div className="min-w-0 space-y-1" data-testid="lead-rights">
        <h3 className="text-sm font-medium">{t("lead_rights_title")}</h3>
        <p className="max-w-2xl text-xs text-muted-foreground">{t("lead_rights_help")}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">{t("lead_col_class")}</th><th className="py-1 pr-2">{t("lead_col_tier")}</th><th className="py-1 pr-2">N / K</th><th className="py-1 pr-2">LB</th><th className="py-1 pr-2">{t("lead_col_coverage")}</th><th className="py-1 pr-2">κ</th></tr></thead>
            <tbody>
              {state.rights.map((row) => {
                const exam = state.exam.find((item) => item.class === row.class);
                return (
                  <tr key={row.class} data-testid={`lead-right-${row.class}`}>
                    <td className="py-1 pr-2 font-medium" title={row.description}>{row.class}</td>
                    <td className="py-1 pr-2">{tierLabel[row.tier]}</td>
                    <td className="py-1 pr-2">{exam ? `${exam.n} / ${exam.k}` : "—"}</td>
                    <td className="py-1 pr-2">{pct(exam?.wilsonLb)}</td>
                    <td className="py-1 pr-2">{pct(exam?.coverage)}</td>
                    <td className="py-1 pr-2">{exam?.kappa == null ? "—" : exam.kappa.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {state.lastExam ? <p className="text-xs text-muted-foreground">{t("lead_last_exam")}: {when(state.lastExam.at, locale)}{state.lastExam.changes.length ? ` — ${state.lastExam.changes.map((change) => `${change.class} ${change.from} → ${change.to}`).join(", ")}` : ` — ${t("lead_no_change")}`}</p> : null}
      </div>
      <div className="min-w-0 space-y-1" data-testid="lead-labels">
        <h3 className="text-sm font-medium">{t("lead_labels_title")} · {state.labels.pending}</h3>
        <p className="max-w-2xl text-xs text-muted-foreground">{t("lead_labels_help")}</p>
        {state.labels.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">{t("lead_col_class")}</th><th className="py-1 pr-2">{t("lead_col_guess")}</th><th className="py-1 pr-2">{t("lead_col_judge")}</th><th className="py-1 pr-2" /></tr></thead>
              <tbody>
                {state.labels.rows.map((row) => {
                  const guess = row.prediction_json ? ((JSON.parse(row.prediction_json) as { option: string | null }).option ?? "—") : "—";
                  const answer = row.answer_json ? (JSON.parse(row.answer_json) as { option: string }).option : "—";
                  const situation = (() => { try { const s = JSON.parse(row.situation_json) as Record<string, unknown>; return String(s.title ?? s.task ?? s.question ?? row.id); } catch { return row.id; } })();
                  return (
                    <tr key={row.id} data-testid={`lead-label-${row.id}`}>
                      <td className="py-1 pr-2" title={row.id}><span className="font-medium">{row.class}</span> <span className="text-muted-foreground">{situation.slice(0, 60)}</span></td>
                      <td className="py-1 pr-2 whitespace-nowrap">{guess} → {answer}</td>
                      <td className="py-1 pr-2">{row.judge_verdict}</td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {(["exact", "partial", "miss"] as const).map((verdict) => (
                          <Button key={verdict} type="button" size="sm" variant={row.judge_verdict === verdict ? "default" : "outline"} className="mr-1" disabled={busy !== null} data-testid={`lead-label-${row.id}-${verdict}`} onClick={() => void label(row.id, verdict)}>{verdict}</Button>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="text-xs text-muted-foreground">{t("lead_labels_none")}</p>}
      </div>
      <Disclosure summary={t("lead_ticks_title")} testId="lead-ticks" compact>
        <ul className="min-w-0 space-y-1 pt-2 text-xs">
          {state.ticks.length ? state.ticks.map((tick) => (
            <li key={tick.id} className="break-words" data-testid={`lead-tick-${tick.id}`}>
              <span className="font-mono">{tick.id}</span> · {tick.status} · {when(tick.started_at, locale)} · {t("lead_proposed")} {JSON.parse(tick.proposed_json ?? "[]").length}, {t("lead_acted")} {JSON.parse(tick.acted_json ?? "[]").length}, ${((tick.cost_micro_usd ?? 0) / USD).toFixed(2)}
            </li>
          )) : <li className="text-muted-foreground">{t("lead_no_tick")}</li>}
        </ul>
      </Disclosure>
      <div className="min-w-0 space-y-2" data-testid="lead-settings">
        <h3 className="text-sm font-medium">{t("lead_settings_title")}</h3>
        {fields}
        <p className="max-w-2xl text-xs text-muted-foreground">{t("lead_identity")}: <code className="break-all">{state.identity.path}</code> · sha {state.identity.sha.slice(0, 12)}</p>
      </div>
    </div>
  );
}
