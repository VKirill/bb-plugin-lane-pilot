import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import { Button, Segments, Surface, SurfaceBody, SurfaceHeader, usePanelLayout } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import { HELPER_PANEL_ACTION } from "../../native-agent/ui";
import { Pill, useOpenThreadPanel } from "../../ui-shell/ui";
import type { ErrandKindOrNone, ErrandOutcome, ErrandRow, KindSummary } from "../logic";

type Payload = { days: number; kinds: KindSummary[]; errands: ErrandRow[] };
type Tone = NonNullable<Parameters<typeof Pill>[0]["tone"]>;
const DAYS = [7, 30, 90] as const;
const KINDS: readonly ErrandKindOrNone[] = ["computer", "devops", "browser", "research", "message", "none"];
const KIND_NAME: Record<ErrandKindOrNone, I18nKey> = { computer: "er_kind_computer", devops: "er_kind_devops", browser: "er_kind_browser", research: "er_kind_research", message: "er_kind_message", none: "er_kind_none" };
const KIND_WHAT: Record<ErrandKindOrNone, I18nKey> = { computer: "er_what_computer", devops: "er_what_devops", browser: "er_what_browser", research: "er_what_research", message: "er_what_message", none: "er_what_none" };
const OUTCOME: Record<ErrandOutcome, { key: I18nKey; tone: Tone }> = {
  running: { key: "er_out_running", tone: "info" }, done: { key: "er_out_done", tone: "success" }, blocked: { key: "er_out_blocked", tone: "warning" },
  failed: { key: "er_out_failed", tone: "danger" }, canceled: { key: "er_out_canceled", tone: "muted" },
};
const BY: Record<string, I18nKey> = { pm: "er_by_pm", hint: "er_by_hint", jev: "er_by_jev", schedule: "er_by_schedule" };
const fill = (key: I18nKey, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
const usd = (value: number) => (value > 0 ? `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");
const short = (model: string) => (model ? model.slice(model.lastIndexOf("/") + 1) : "—");
const when = (ms: number, locale: Locale) => new Date(ms).toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const th = "py-1.5 pr-3 font-medium";
const td = "py-1.5 pr-3 align-top";

/**
 * «Errands»: a one-off job a helper does outside the code (a screen, a server, a site, a report, a message), given by a PM from its chat, by a
 * schedule or by the lead. The top block is the registry of kinds with the model each runs on (the role table's row) and the period's counts;
 * below it the errands themselves with outcome, who asked and the helper's chat. A new kind (src/rooms/schedule/errand-kinds.ts) appears here by itself.
 */
export function ErrandsScreen({ projects, locale }: { projects: Array<{ id: string; name: string }>; locale: Locale }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const openPanel = useOpenThreadPanel();
  const { stackControls } = usePanelLayout();
  const [days, setDays] = useState<number>(7);
  const [kind, setKind] = useState<"all" | ErrandKindOrNone>("all");
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    rpc.call("errands_overview", { days }).then((next) => { if (live) setData(next as Payload); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [days, rpc]);
  const projectName = (id: string | null) => (id ? projects.find((project) => project.id === id)?.name ?? id : "");
  const open = (row: ErrandRow) => {
    if (!row.threadId) return;
    if (!openPanel({ actionId: HELPER_PANEL_ACTION, title: row.title.slice(0, 40), params: { threadId: row.threadId } })) navigate.toThread(row.threadId);
  };
  const list = (data?.errands ?? []).filter((row) => kind === "all" || row.kind === kind);
  const sourceText = (row: ErrandRow) => row.source.type === "schedule" ? fill("er_src_schedule", { name: row.source.name || t("er_src_schedule_gone") }) : row.source.type === "pm" ? t("er_src_pm") : t("er_src_other");
  return (
    <div className="space-y-6" data-testid="errands-screen">
      <div>
        <h1 className="text-lg font-semibold">{t("er_title")}</h1>
        <p className="max-w-3xl text-xs text-muted-foreground">{t("er_help")}</p>
      </div>
      <Surface testId="errand-kinds">
        <SurfaceHeader className="justify-between"><h2 className="text-sm font-medium">{t("er_kinds_title")}</h2></SurfaceHeader>
        <SurfaceBody className="space-y-3">
          <p className="max-w-3xl text-xs text-muted-foreground">{t("er_kinds_help")}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="errand-kinds-table">
              <thead><tr className="border-b text-left text-muted-foreground">
                <th className={th}>{t("er_col_kind")}</th><th className={th}>{t("er_col_what")}</th><th className={th}>{t("er_col_model")}</th>
                <th className={th}>{t("er_col_runs")}</th><th className={th}>{t("er_col_done")}</th><th className={th}>{t("er_col_blocked")}</th><th className={th}>{t("er_col_failed")}</th>
                <th className={th}>{t("er_col_cost")}</th><th className={th}>{t("er_col_jev")}</th>
              </tr></thead>
              <tbody>
                {(data?.kinds ?? KINDS.map((id) => null as KindSummary | null)).map((row, index) => {
                  const id = row?.kind ?? KINDS[index]!;
                  return (
                    <tr key={id} className="border-b last:border-b-0" data-testid={`errand-kind-${id}`}>
                      <td className={`${td} font-medium`}>{t(KIND_NAME[id])}</td>
                      <td className={`${td} text-muted-foreground`}>{t(KIND_WHAT[id])}</td>
                      <td className={td}>{row ? <>{short(row.model)}{row.effort ? ` · ${row.effort}` : ""}<div className="text-[11px] text-muted-foreground">{row.role} · {t(row.source === "table" ? "er_model_owner" : "er_model_builtin")}</div></> : "…"}</td>
                      <td className={td}>{row?.runs ?? "…"}</td><td className={td}>{row?.done ?? "…"}</td><td className={td}>{row?.blocked ?? "…"}</td><td className={td}>{row?.failed ?? "…"}</td>
                      <td className={td}>{row ? usd(row.costUsd) : "…"}</td><td className={td}>{row?.jevWouldPick ?? "…"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SurfaceBody>
      </Surface>
      <Surface testId="errand-list">
        <SurfaceHeader className="flex-wrap justify-between gap-2">
          <h2 className="text-sm font-medium">{fill("er_list_title", { days })}</h2>
          <div className="flex flex-wrap gap-2">
            <Segments testId="errand-days" label={t("er_days")} compact={stackControls} value={String(days)} onChange={(next) => setDays(Number(next))}
              items={DAYS.map((value) => ({ id: String(value), label: fill("er_days_n", { days: value }) }))} />
            <Segments testId="errand-kind-filter" label={t("er_filter_kind")} compact={stackControls} value={kind} onChange={(next) => setKind(next as "all" | ErrandKindOrNone)}
              items={[{ id: "all", label: t("er_filter_all") }, ...KINDS.map((id) => ({ id, label: t(KIND_NAME[id]) }))]} />
          </div>
        </SurfaceHeader>
        <SurfaceBody>
          {failed ? <p className="text-sm text-destructive" data-testid="errands-failed">{t("er_load_failed")}</p>
            : !data ? <p className="text-sm text-muted-foreground">…</p>
            : list.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="errands-empty">{t("er_empty")}</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="errands-table">
                  <thead><tr className="border-b text-left text-muted-foreground">
                    <th className={th}>{t("er_col_when")}</th><th className={th}>{t("er_col_project")}</th><th className={th}>{t("er_col_errand")}</th><th className={th}>{t("er_col_kind")}</th>
                    <th className={th}>{t("er_col_model")}</th><th className={th}>{t("er_col_outcome")}</th><th className={th}>{t("er_col_source")}</th><th className={th}>{t("er_col_cost")}</th><th className={th} />
                  </tr></thead>
                  <tbody>
                    {list.map((row) => (
                      <tr key={row.id} className="border-b last:border-b-0" data-testid="errand-row" data-kind={row.kind} data-outcome={row.outcome}>
                        <td className={`${td} whitespace-nowrap`}>{when(row.startedAt, locale)}</td>
                        <td className={td}>{projectName(row.projectId)}</td>
                        <td className={`${td} max-w-md`}>{row.title}</td>
                        <td className={td}>{t(KIND_NAME[row.kind])}{row.kindBy && BY[row.kindBy] ? <div className="text-[11px] text-muted-foreground">{t(BY[row.kindBy]!)}</div> : null}</td>
                        <td className={td}>{short(row.model)}</td>
                        <td className={td}><Pill tone={OUTCOME[row.outcome].tone}>{t(OUTCOME[row.outcome].key)}</Pill>{row.reason ? <div className="mt-1 max-w-xs text-[11px] text-muted-foreground">{row.reason}</div> : null}</td>
                        <td className={td}>{sourceText(row)}</td>
                        <td className={`${td} whitespace-nowrap`}>{usd(row.costUsd)}</td>
                        <td className={td}>{row.threadId ? <Button size="sm" variant="outline" onClick={() => open(row)} data-testid="errand-open">{t("er_open_thread")}</Button> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </SurfaceBody>
      </Surface>
    </div>
  );
}
