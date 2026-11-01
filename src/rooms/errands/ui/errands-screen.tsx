import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import { roleModelKey, type ModelCatalog } from "@lane-pilot/models";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { Button, Segments, Surface, SurfaceBody, SurfaceHeader, usePanelLayout } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import { HELPER_PANEL_ACTION } from "../../native-agent/ui";
import { Pill, useOpenThreadPanel } from "../../ui-shell/ui";
import { NativeModelPicker, useModelCatalog, type ModelChoice } from "../../workflow/ui";
import type { ErrandKindOrNone, ErrandOutcome, ErrandRow, KindSummary } from "../logic";

type Payload = { days: number; kinds: KindSummary[]; errands: ErrandRow[] };
type RoleRow = { role: string; providerId: string; model: string; effort: string; own: boolean; version: number; pool: Array<{ providerId: string; model: string; effort: string | null }> };
type Pick = { provider: string; model: string; reasoning_effort?: string };
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
const when = (ms: number, locale: Locale) => new Date(ms).toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const th = "py-1.5 pr-3 font-medium";
const td = "py-2 pr-3 align-top";

/** The helper's reason in the owner's words (the owner-facing rule of 0.1.456): the few technical strings the graph writes get a plain line, the rest stays as it is. */
export function plainReason(reason: string): string {
  if (!reason) return "";
  if (/cancel/iu.test(reason)) return t("er_why_canceled");
  if (reason === "no_host") return t("er_why_no_host");
  const step = /^step_failed:([a-z0-9_-]+)/iu.exec(reason)?.[1];
  if (step === "work") return t("er_why_work");
  if (step) return fill("er_why_step", { step });
  return reason;
}

/**
 * «Errands»: a one-off job a helper does outside the code (a screen, a server, a site, a report, a message), given by a PM from its chat, by a
 * schedule or by the lead. The top block is the registry of kinds, each with BB's own model window on the row of the role table it runs on
 * (saved at the global level, the pool of the row kept) and the period's counts; below it the errands themselves with outcome, who asked and
 * the helper's chat. A new kind (src/rooms/schedule/errand-kinds.ts) appears here by itself.
 */
export function ErrandsScreen({ projects, locale }: { projects: Array<{ id: string; name: string }>; locale: Locale }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const openPanel = useOpenThreadPanel();
  const { stackControls } = usePanelLayout();
  const catalog = useModelCatalog();
  const [days, setDays] = useState<number>(7);
  const [kind, setKind] = useState<"all" | ErrandKindOrNone>("all");
  const [data, setData] = useState<Payload | null>(null);
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState(false);
  const loadRoles = useCallback(() => rpc.call("get_role_models", { projectId: GLOBAL_SETTINGS_PROJECT_ID }).then((next) => setRoles((next as { roles: RoleRow[] }).roles), () => setRoles(null)), [rpc]);
  const load = useCallback(() => rpc.call("errands_overview", { days }).then((next) => { setData(next as Payload); setFailed(false); }, () => setFailed(true)), [days, rpc]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadRoles(); }, [loadRoles]);

  const label = (entry: { providerId: string; model: string }) => catalog?.providers.find((p) => p.id === entry.providerId)?.models.find((m) => m.id === entry.model)?.displayName ?? (entry.model ? entry.model.slice(entry.model.lastIndexOf("/") + 1) : "—");
  const pickOf = (entry: { providerId: string; model: string; effort: string | null }): Pick => ({ provider: entry.providerId, model: entry.model, ...(entry.effort ? { reasoning_effort: entry.effort } : {}) });
  /** The choice goes into the role's row at the global level, as the role table does it; the other models of the row's pool travel with it. */
  const save = async (row: RoleRow, choice: ModelChoice | null) => {
    setBusy(true);
    try {
      const next = choice ? pickOf({ providerId: choice.providerId, model: choice.model, effort: choice.effort ?? null }) : null;
      const pool = next ? row.pool.map(pickOf).filter((entry) => !(entry.provider === next.provider && entry.model === next.model)) : [];
      const result = await rpc.call("save_setting", { projectId: GLOBAL_SETTINGS_PROJECT_ID, key: roleModelKey(row.role), value: next ? { ...next, ...(pool.length ? { pool } : {}) } : null, expectedVersion: row.version });
      setSaveError(result.ok ? "" : t("er_save_failed"));
      await Promise.all([loadRoles(), load()]);
    } catch { setSaveError(t("er_save_failed")); }
    setBusy(false);
  };

  const projectName = (id: string | null) => (id ? projects.find((project) => project.id === id)?.name ?? id : "");
  const open = (row: ErrandRow) => {
    if (!row.threadId) return;
    if (!openPanel({ actionId: HELPER_PANEL_ACTION, title: row.title.slice(0, 40), params: { threadId: row.threadId } })) navigate.toThread(row.threadId);
  };
  const list = (data?.errands ?? []).filter((row) => kind === "all" || row.kind === kind);
  const sourceText = (row: ErrandRow) => {
    if (row.source.type === "pm") return t("er_src_pm");
    if (row.source.type !== "schedule") return t("er_src_other");
    const name = row.source.name;
    return !name ? fill("er_src_schedule", { name: t("er_src_schedule_gone") }) : name === row.title ? t("er_src_schedule_plain") : fill("er_src_schedule", { name });
  };
  const kinds = data?.kinds ?? null;
  const seenRole = new Set<string>();
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
          {saveError ? <p className="text-xs text-destructive-text" role="alert" data-testid="errand-save-error">{saveError}</p> : null}
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="errand-kinds-table">
              <thead><tr className="border-b text-left text-muted-foreground">
                <th className={th}>{t("er_col_kind")}</th><th className={th}>{t("er_col_what")}</th><th className={`${th} min-w-[16rem]`}>{t("er_col_model")}</th>
                <th className={`${th} text-right`}>{t("er_col_runs")}</th><th className={`${th} text-right`}>{t("er_col_done")}</th><th className={`${th} text-right`}>{t("er_col_blocked")}</th><th className={`${th} text-right`}>{t("er_col_failed")}</th>
                <th className={`${th} text-right`}>{t("er_col_cost")}</th><th className={`${th} text-right`}>{t("er_col_jev")}</th>
              </tr></thead>
              <tbody>
                {KINDS.map((id) => {
                  const row = kinds?.find((item) => item.kind === id) ?? null;
                  const roleRow = row ? roles?.find((item) => item.role === row.role) ?? null : null;
                  const first = row ? !seenRole.has(row.role) : true;
                  if (row) seenRole.add(row.role);
                  const quiet = row && row.runs === 0 ? "text-muted-foreground" : "";
                  const num = (value: number | undefined, text?: string) => (row && row.runs === 0 ? "—" : value === undefined ? "…" : text ?? value);
                  return (
                    <tr key={id} className="border-b last:border-b-0" data-testid={`errand-kind-${id}`}>
                      <td className={`${td} font-medium`}>{t(KIND_NAME[id])}</td>
                      <td className={`${td} text-muted-foreground`}>{t(KIND_WHAT[id])}</td>
                      <td className={td}>
                        {!row ? "…" : !first ? <span className="text-muted-foreground" data-testid={`errand-model-same-${id}`}>{fill("er_same_row", { kind: t(KIND_NAME[KINDS.find((other) => kinds?.find((item) => item.kind === other)?.role === row.role) ?? "message"]) })}</span>
                          : catalog && roleRow ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <NativeModelPicker catalog={catalog} seed={{ providerId: roleRow.providerId, model: roleRow.model, effort: roleRow.effort, serviceTier: null }} disabled={busy}
                                testId={`errand-model-pick-${id}`} label={fill("er_model_label", { kind: t(KIND_NAME[id]) })} className="min-w-0" onChoose={(choice) => void save(roleRow, choice)} />
                              <span className="text-[11px] text-muted-foreground">{t(roleRow.own ? "er_model_owner" : "er_model_builtin")}</span>
                              {roleRow.own ? <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={busy} data-testid={`errand-model-reset-${id}`} onClick={() => void save(roleRow, null)}>{t("er_model_reset")}</Button> : null}
                            </div>
                          ) : <span data-testid={`errand-model-pick-${id}`}>{label(row)}{row.effort ? ` · ${row.effort}` : ""}</span>}
                      </td>
                      <td className={`${td} text-right tabular-nums ${quiet}`}>{row ? row.runs : "…"}</td>
                      <td className={`${td} text-right tabular-nums ${quiet}`}>{num(row?.done)}</td>
                      <td className={`${td} text-right tabular-nums ${quiet}`}>{num(row?.blocked)}</td>
                      <td className={`${td} text-right tabular-nums ${quiet}`}>{num(row?.failed)}</td>
                      <td className={`${td} text-right tabular-nums ${quiet}`}>{num(row?.costUsd, row ? usd(row.costUsd) : undefined)}</td>
                      <td className={`${td} text-right tabular-nums ${quiet}`}>{num(row?.jevWouldPick)}</td>
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
                    <th className={th}>{t("er_col_model")}</th><th className={th}>{t("er_col_outcome")}</th><th className={th}>{t("er_col_source")}</th><th className={`${th} text-right`}>{t("er_col_cost")}</th><th className={th} />
                  </tr></thead>
                  <tbody>
                    {list.map((row) => (
                      <tr key={row.id} className="border-b last:border-b-0" data-testid="errand-row" data-kind={row.kind} data-outcome={row.outcome}>
                        <td className={`${td} whitespace-nowrap tabular-nums`}>{when(row.startedAt, locale)}</td>
                        <td className={td}>{projectName(row.projectId)}</td>
                        <td className={`${td} max-w-md`}>{row.title}</td>
                        <td className={td}>{t(KIND_NAME[row.kind])}{row.kindBy && BY[row.kindBy] ? <div className="text-[11px] text-muted-foreground">{t(BY[row.kindBy]!)}</div> : null}</td>
                        <td className={`${td} whitespace-nowrap`}>{label(row)}</td>
                        <td className={td}><Pill tone={OUTCOME[row.outcome].tone}>{t(OUTCOME[row.outcome].key)}</Pill>{row.reason ? <div className="mt-1 max-w-xs text-[11px] text-muted-foreground" data-testid="errand-reason">{plainReason(row.reason)}</div> : null}</td>
                        <td className={`${td} max-w-[14rem]`}>{sourceText(row)}</td>
                        <td className={`${td} whitespace-nowrap text-right tabular-nums`}>{usd(row.costUsd)}</td>
                        <td className={`${td} text-right`}>{row.threadId ? <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => open(row)} data-testid="errand-open">{t("er_open_thread")}</Button> : null}</td>
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
