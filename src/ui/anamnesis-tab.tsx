import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../contracts";
import type { AnamnesisConfig } from "../anamnesis/hub";
import type { AnamnesisRecord, AnamnesisRecordFull, HistoryEntry, Kind, Sensitivity, Source, Status } from "../anamnesis/model";
import type { AnamnesisRequest, OpName, ResponseOf } from "../anamnesis/ops";
import { LEVELS, stepsOf, type SkillStep } from "../anamnesis/skills";
import { t, type I18nKey } from "../../i18n";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { Disclosure } from "./disclosure";
import { Surface, SurfaceBody, SurfaceHeader } from "./surface";

/**
 * The Anamnesis tab (A6): what Lane Pilot knows about its owner, on the owner's machine. Everything here is the one RPC `anamnesis`
 * (src/anamnesis/ops.ts) asked through the hub; the records never leave the Mac mini except as the text of a request the owner makes.
 * Sensitive records (family, health, money, documents, clients) are hidden until the owner asks to see them; nothing is shown as
 * public unless the owner marked it so here.
 */
type View = "me" | "review" | "records" | "skills" | "timeline" | "sources" | "reports";
const VIEWS: readonly View[] = ["me", "review", "records", "skills", "timeline", "sources", "reports"];
const KIND_LIST: readonly Kind[] = ["self", "skill", "project", "event", "person", "interest", "preference", "fact", "tool"];
const STATUS_LIST: readonly Status[] = ["candidate", "draft", "confirmed", "rejected"];
const SENSITIVITY_LIST: readonly Sensitivity[] = ["public", "private", "sensitive"];
const PAGE = 40;
/** Two clicks on a destructive button: the first arms it for this long. */
const ARM_MS = 5_000;

const day = (at: number | null): string => (at ? new Date(at).toISOString().slice(0, 10) : "—");
const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const label = (key: string): string => t(key as I18nKey);

type Ask = <O extends OpName>(request: Extract<AnamnesisRequest, { op: O }>) => Promise<ResponseOf<O>>;

function useAsk(): Ask {
  const rpc = useRpc<typeof rpcContract>();
  return useCallback((async (request: AnamnesisRequest) => (await rpc.call("anamnesis", { request })).result) as Ask, [rpc]);
}

/** A destructive button that asks twice. */
function ArmedButton({ children, armedText, onConfirm, testId, disabled }: { children: ReactNode; armedText: string; onConfirm: () => void; testId?: string; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button size="sm" variant={armed ? "destructive" : "outline"} className="h-7 px-2" data-testid={testId} disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? armedText : children}
    </Button>
  );
}

const SELECT_CLASS = "h-8 rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] px-2 text-xs";

/* ---------------------------------------------------------------- one record */

function RecordRow({ record, ask, onChanged, byId }: { record: AnamnesisRecord; ask: Ask; onChanged: () => void; byId: Map<string, AnamnesisRecord> }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [full, setFull] = useState<AnamnesisRecordFull | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [draft, setDraft] = useState({ title: record.title, statement: record.statement, sensitivity: record.sensitivity });
  const [busy, setBusy] = useState(false);
  const contradicts = Array.isArray(record.attributes.contradicts) ? (record.attributes.contradicts as unknown[]).map(String) : [];

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); onChanged(); } catch (cause) { toast.error(errorText(cause)); } finally { setBusy(false); }
  };
  const edit = (patch: Record<string, unknown>, reason: string) => run(async () => { await ask({ op: "edit", id: record.id, patch: patch as never, reason }); setEditing(false); setFull(null); setHistory(null); });

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !full) {
      try {
        const sensitive = record.sensitivity === "sensitive";
        setFull((await ask({ op: "get", id: record.id, ...(sensitive ? { includeSensitive: true } : {}) })).record);
        setHistory((await ask({ op: "history", id: record.id, limit: 20 })).history);
      } catch (cause) { toast.error(errorText(cause)); }
    }
  };

  return (
    <div className="space-y-1.5 rounded-lg border border-[var(--lp-hairline)] p-2.5 text-sm" data-testid={`anm-record-${record.id}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{label(`anmKind_${record.kind}`)}</Badge>
        <Badge variant={record.status === "confirmed" ? "success" : record.status === "rejected" ? "destructive" : "secondary"}>{label(`anmStatus_${record.status}`)}</Badge>
        <Badge variant={record.sensitivity === "public" ? "success" : record.sensitivity === "sensitive" ? "destructive" : "default"} data-testid={`anm-sens-${record.id}`}>{label(`anmSens_${record.sensitivity}`)}</Badge>
        <span className="text-xs text-muted-foreground">{t("anmConfidence")} {Math.round(record.confidence * 100)}% · {record.evidenceCount} {t("anmEvidence")} · {day(record.firstSeen)}…{day(record.lastSeen)}</span>
      </div>
      {editing ? (
        <div className="space-y-2">
          <Input aria-label={t("anmFieldTitle")} value={draft.title} maxLength={160} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          <textarea aria-label={t("anmFieldStatement")} className="min-h-16 w-full rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] p-2 text-sm" maxLength={600} value={draft.statement}
            onChange={(event) => setDraft({ ...draft, statement: event.target.value })} />
          <label className="flex items-center gap-2 text-xs">{t("anmFieldSensitivity")}
            <select className={SELECT_CLASS} value={draft.sensitivity} onChange={(event) => setDraft({ ...draft, sensitivity: event.target.value as Sensitivity })}>
              {SENSITIVITY_LIST.map((value) => <option key={value} value={value}>{label(`anmSens_${value}`)}</option>)}
            </select>
          </label>
          {draft.sensitivity === "public" ? <p className="text-xs text-muted-foreground">{t("anmPublicHint")}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !draft.title.trim()} onClick={() => void edit({ title: draft.title.trim(), statement: draft.statement.trim(), sensitivity: draft.sensitivity }, "edited in the Anamnesis tab")}>{t("anmSave")}</Button>
            <Button size="sm" variant="outline" onClick={() => { setEditing(false); setDraft({ title: record.title, statement: record.statement, sensitivity: record.sensitivity }); }}>{t("anmCancel")}</Button>
          </div>
        </div>
      ) : (
        <div style={{ overflowWrap: "anywhere" }}>
          <p className="font-medium">{record.title}</p>
          {record.statement && record.statement !== record.title ? <p className="text-muted-foreground">{record.statement}</p> : null}
        </div>
      )}
      {contradicts.length ? <p className="text-xs text-[var(--lp-danger,inherit)]" data-testid={`anm-contradicts-${record.id}`}>{t("anmContradicts")}: {contradicts.map((id) => byId.get(id)?.title ?? id).join("; ")}</p> : null}
      {!editing ? (
        <div className="flex flex-wrap gap-1.5">
          {record.status !== "confirmed" ? <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} data-testid={`anm-confirm-${record.id}`} onClick={() => void edit({ status: "confirmed" }, "confirmed in the Anamnesis tab")}>{t("anmConfirm")}</Button> : null}
          {record.status !== "rejected" ? <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} data-testid={`anm-reject-${record.id}`} onClick={() => void edit({ status: "rejected" }, "rejected in the Anamnesis tab")}>{t("anmReject")}</Button> : null}
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} data-testid={`anm-edit-${record.id}`} onClick={() => setEditing(true)}>{t("anmEdit")}</Button>
          {record.sensitivity === "private" ? <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} data-testid={`anm-public-${record.id}`} onClick={() => void edit({ sensitivity: "public" }, "marked public in the Anamnesis tab")}>{t("anmMakePublic")}</Button>
            : record.sensitivity === "public" ? <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} data-testid={`anm-private-${record.id}`} onClick={() => void edit({ sensitivity: "private" }, "marked private in the Anamnesis tab")}>{t("anmMakePrivate")}</Button> : null}
          <Button size="sm" variant="ghost" className="h-7 px-2" data-testid={`anm-more-${record.id}`} onClick={() => void toggle()}>{open ? t("anmHide") : t("anmEvidenceButton")}</Button>
          <ArmedButton testId={`anm-forget-${record.id}`} disabled={busy} armedText={t("anmForgetSure")} onConfirm={() => void run(() => ask({ op: "forget", id: record.id }))}>{t("anmForget")}</ArmedButton>
        </div>
      ) : null}
      {open ? (
        <div className="space-y-2 pt-1 text-xs" data-testid={`anm-detail-${record.id}`}>
          <div>
            <p className="font-medium">{t("anmEvidenceHeading")}</p>
            {full ? <ul className="space-y-0.5">{full.evidence.slice(-20).map((item) => <li key={`${item.source}:${item.ref}`} style={{ overflowWrap: "anywhere" }}>{day(item.at)} · {item.source} · {item.ref}{item.quote ? ` · “${item.quote}”` : ""}</li>)}</ul> : <p className="text-muted-foreground">…</p>}
          </div>
          <div>
            <p className="font-medium">{t("anmHistoryHeading")}</p>
            {history ? (history.length ? <ul className="space-y-0.5">{history.map((entry) => <li key={entry.id} style={{ overflowWrap: "anywhere" }}>{day(entry.at)} · {entry.actor} · {entry.action}: {entry.reason}</li>)}</ul> : <p className="text-muted-foreground">{t("anmNone")}</p>) : <p className="text-muted-foreground">…</p>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- charts */

const LEVEL_Y = Object.fromEntries(LEVELS.map((level, index) => [level, index])) as Record<string, number>;

/** The level of one skill over months as a step line: x is time from the first to the last month, y the four levels. */
export function LevelChart({ steps, from, to }: { steps: readonly SkillStep[]; from: string; to: string }) {
  const index = (month: string): number => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  const start = index(from), span = Math.max(1, index(to) - start);
  const x = (month: string): number => 8 + ((index(month) - start) / span) * 184;
  const y = (level: string): number => 52 - (LEVEL_Y[level] ?? 0) * 14;
  let path = "";
  let previous = 52;
  steps.forEach((step, i) => {
    path += `${i === 0 ? "M" : "L"}${x(step.month).toFixed(1)},${previous} L${x(step.month).toFixed(1)},${y(step.level)} `;
    previous = y(step.level);
  });
  path += `L192,${previous}`;
  return (
    <svg viewBox="0 0 200 60" role="img" aria-label={steps.map((step) => `${step.month} ${step.level}`).join(", ")} className="h-14 w-full max-w-xs" data-testid="anm-level-chart">
      {LEVELS.map((level) => <line key={level} x1="8" x2="192" y1={y(level)} y2={y(level)} stroke="currentColor" strokeOpacity="0.12" />)}
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" />
      {steps.map((step) => <circle key={step.month} cx={x(step.month)} cy={y(step.level)} r="2.5" fill="currentColor"><title>{`${step.month}: ${step.level}`}</title></circle>)}
    </svg>
  );
}

/* ---------------------------------------------------------------- the tab */

export function AnamnesisTab() {
  const ask = useAsk();
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<View>("me");
  const [status, setStatus] = useState<ResponseOf<"status"> | null>(null);
  const [config, setConfig] = useState<AnamnesisConfig>({});
  const [records, setRecords] = useState<AnamnesisRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSensitive, setShowSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [passReport, setPassReport] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextConfig] = await Promise.all([ask({ op: "status" }), rpc.call("anamnesis", { request: { op: "config" } }).then((answer) => (answer.result as { config: AnamnesisConfig }).config)]);
      setStatus(nextStatus); setConfig(nextConfig); setError(null);
      setRecords((await ask({ op: "list", limit: 2000, ...(showSensitive ? { includeSensitive: true } : {}) })).records);
    } catch (cause) { setError(errorText(cause)); }
  }, [ask, rpc, showSensitive]);
  useEffect(() => { void refresh(); }, [refresh]);

  const byId = useMemo(() => new Map((records ?? []).map((record) => [record.id, record])), [records]);
  const setConfigValue = async (set: Record<string, unknown>) => {
    try { setConfig(((await rpc.call("anamnesis", { request: { op: "config", set: set as never } })).result as { config: AnamnesisConfig }).config); } catch (cause) { toast.error(errorText(cause)); }
  };
  const runPass = async () => {
    setBusy(true);
    try {
      const report = (await rpc.call("anamnesis", { request: { op: "pass" } })).result as { ran?: boolean; note?: string; messages?: { total: number; extract?: { created: number; merged: number; contradictions: number } | null } | null };
      const extract = report.messages?.extract;
      setPassReport(report.ran ? t("anmPassDone").replace("{messages}", String(report.messages?.total ?? 0)).replace("{created}", String(extract?.created ?? 0)).replace("{merged}", String(extract?.merged ?? 0)).replace("{contradictions}", String(extract?.contradictions ?? 0)) : report.note ?? "");
      await refresh();
    } catch (cause) { toast.error(errorText(cause)); } finally { setBusy(false); }
  };

  const sensitiveHidden = status?.counts.bySensitivity.sensitive ?? 0;
  const toReview = (records ?? []).filter((record) => record.status === "candidate" || record.status === "draft");
  const contradictions = toReview.filter((record) => Array.isArray(record.attributes.contradicts) && (record.attributes.contradicts as unknown[]).length > 0);

  return (
    <Surface testId="anamnesis-tab" className="max-w-3xl">
      <SurfaceHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t("anmTitle")}</h2>
          <p className="text-xs text-muted-foreground">{t("anmHelp")}</p>
        </div>
      </SurfaceHeader>
      <SurfaceBody>
        {error ? (
          <div className="space-y-2 rounded-lg border border-[var(--lp-hairline)] p-3 text-sm" data-testid="anm-error">
            <p>{t("anmUnreachable")}</p>
            <p className="text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }}>{error}</p>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>{t("anmRetry")}</Button>
          </div>
        ) : null}
        {status ? (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--lp-hairline)] p-3" data-testid="anm-auto">
              <Switch checked={config.extract === true} aria-label={t("anmAuto")} data-testid="anm-auto-switch" onCheckedChange={(checked) => void setConfigValue({ extract: checked })} />
              <div className="min-w-[14rem] flex-1 space-y-0.5">
                <p className="text-sm font-medium">{t("anmAuto")}</p>
                <p className="text-xs text-muted-foreground">{t("anmAutoHelp").replace("{n}", String(config.maxClassify ?? 200))}</p>
              </div>
              <Button size="sm" variant="outline" disabled={busy || config.extract !== true} data-testid="anm-run-pass" onClick={() => void runPass()}>{t("anmRunNow")}</Button>
            </div>
            {passReport ? <p className="text-xs text-muted-foreground" data-testid="anm-pass-report">{passReport}</p> : null}
            <p className="text-xs text-muted-foreground" data-testid="anm-counts">
              {t("anmCounts").replace("{records}", String(status.counts.records)).replace("{evidence}", String(status.counts.evidence)).replace("{review}", String(toReview.length))}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <div className="lp-seg flex flex-wrap" role="tablist" aria-label={t("anmTitle")}>
                {VIEWS.map((id) => (
                  <Button key={id} variant="ghost" role="tab" data-testid={`anm-view-${id}`} className="lp-seg-item h-[1.875rem] px-3 hover:bg-transparent aria-pressed:bg-[var(--lp-card)]" aria-pressed={view === id} onClick={() => setView(id)}>
                    {label(`anmView_${id}`)}{id === "review" && toReview.length ? ` (${toReview.length})` : ""}
                  </Button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs" data-testid="anm-sensitive-toggle">
              <Switch checked={showSensitive} aria-label={t("anmShowSensitive")} onCheckedChange={setShowSensitive} />
              {t("anmShowSensitive")}{!showSensitive && sensitiveHidden ? ` — ${t("anmSensitiveHidden").replace("{n}", String(sensitiveHidden))}` : ""}
            </label>
            {view === "me" ? <MeView ask={ask} showSensitive={showSensitive} /> : null}
            {view === "review" && records ? <ReviewView ask={ask} records={toReview} contradictions={contradictions} byId={byId} onChanged={() => void refresh()} /> : null}
            {view === "records" && records ? <RecordsView ask={ask} records={records} byId={byId} onChanged={() => void refresh()} /> : null}
            {view === "skills" && records ? <SkillsView records={records} /> : null}
            {view === "timeline" && records ? <TimelineView records={records} /> : null}
            {view === "sources" ? <SourcesView ask={ask} status={status} config={config} onConfig={setConfigValue} onChanged={() => void refresh()} /> : null}
            {view === "reports" ? <ReportsView ask={ask} /> : null}
            <div className="border-t border-[var(--lp-hairline)] pt-3">
              <ArmedButton testId="anm-forget-all" armedText={t("anmForgetAllSure")} onConfirm={() => void ask({ op: "forget", all: true }).then(() => refresh(), (cause) => toast.error(errorText(cause)))}>{t("anmForgetAll")}</ArmedButton>
              <p className="pt-1 text-xs text-muted-foreground">{t("anmForgetAllHelp")}</p>
            </div>
          </>
        ) : !error ? <p className="text-sm text-muted-foreground">{t("anmLoading")}</p> : null}
      </SurfaceBody>
    </Surface>
  );
}

/* ---------------------------------------------------------------- views */

function MeView({ ask, showSensitive }: { ask: Ask; showSensitive: boolean }) {
  const [detail, setDetail] = useState<"brief" | "normal" | "full">("normal");
  const [drafts, setDrafts] = useState(true);
  const [publicOnly, setPublicOnly] = useState(false);
  const [year, setYear] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [card, setCard] = useState<{ text: string; chars: number } | null>(null);
  useEffect(() => {
    let current = true;
    const yearNumber = Number(year);
    void ask({ op: "whoami", detail, includeDrafts: drafts, ...(showSensitive ? { includeSensitive: true } : {}), ...(publicOnly ? { publicOnly: true } : {}), ...(year && Number.isInteger(yearNumber) && yearNumber >= 2000 ? { year: yearNumber } : {}) })
      .then((answer) => { if (current) setText(answer.text); }, (cause) => { if (current) setText(errorText(cause)); });
    return () => { current = false; };
  }, [ask, detail, drafts, showSensitive, publicOnly, year]);
  useEffect(() => { void ask({ op: "card" }).then(setCard, () => setCard(null)); }, [ask]);
  return (
    <div className="space-y-3" data-testid="anm-me">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">{t("anmDetail")}
          <select className={SELECT_CLASS} value={detail} aria-label={t("anmDetail")} onChange={(event) => setDetail(event.target.value as typeof detail)}>
            {(["brief", "normal", "full"] as const).map((value) => <option key={value} value={value}>{label(`anmDetail_${value}`)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1"><Switch checked={drafts} aria-label={t("anmWithDrafts")} onCheckedChange={setDrafts} />{t("anmWithDrafts")}</label>
        <label className="flex items-center gap-1"><Switch checked={publicOnly} aria-label={t("anmPublicOnly")} onCheckedChange={setPublicOnly} />{t("anmPublicOnly")}</label>
        <label className="flex items-center gap-1">{t("anmYear")}
          <Input className="h-8 w-20" inputMode="numeric" placeholder="2026" aria-label={t("anmYear")} value={year} onChange={(event) => setYear(event.target.value.replace(/\D/g, "").slice(0, 4))} />
        </label>
      </div>
      <pre className="whitespace-pre-wrap rounded-lg border border-[var(--lp-hairline)] p-3 text-xs" style={{ overflowWrap: "anywhere" }} data-testid="anm-whoami">{text ?? "…"}</pre>
      <Disclosure compact summary={t("anmCardHeading")} testId="anm-card">
        <div className="space-y-1 pt-1">
          <p className="text-xs text-muted-foreground">{t("anmCardHelp")}</p>
          <pre className="whitespace-pre-wrap rounded-lg border border-[var(--lp-hairline)] p-2 text-xs" style={{ overflowWrap: "anywhere" }}>{card?.text ?? "…"}</pre>
          {card ? <p className="text-xs text-muted-foreground">{card.chars} / 1800</p> : null}
        </div>
      </Disclosure>
    </div>
  );
}

function ReviewView({ ask, records, contradictions, byId, onChanged }: { ask: Ask; records: AnamnesisRecord[]; contradictions: AnamnesisRecord[]; byId: Map<string, AnamnesisRecord>; onChanged: () => void }) {
  const [shown, setShown] = useState(PAGE);
  const settle = async (keep: AnamnesisRecord, drop: AnamnesisRecord | undefined) => {
    try {
      await ask({ op: "edit", id: keep.id, patch: { status: "confirmed" }, reason: "contradiction settled in the Anamnesis tab: the newer statement is right" });
      if (drop) await ask({ op: "edit", id: drop.id, patch: { status: "rejected" }, reason: "contradiction settled in the Anamnesis tab: replaced by a newer statement" });
      onChanged();
    } catch (cause) { toast.error(errorText(cause)); }
  };
  const rest = records.filter((record) => !contradictions.includes(record));
  return (
    <div className="space-y-3" data-testid="anm-review">
      <p className="text-xs text-muted-foreground">{t("anmReviewHelp")}</p>
      {contradictions.length ? (
        <div className="space-y-2" data-testid="anm-contradictions">
          <p className="text-sm font-medium">{t("anmContradictionsHeading")} ({contradictions.length})</p>
          {contradictions.map((record) => {
            const old = byId.get(String((record.attributes.contradicts as unknown[])[0]));
            return (
              <div key={record.id} className="space-y-1.5 rounded-lg border border-[var(--lp-hairline)] p-2.5 text-sm" data-testid={`anm-contradiction-${record.id}`}>
                <p><span className="text-xs text-muted-foreground">{t("anmOld")}: </span>{old ? `${old.title}${old.statement && old.statement !== old.title ? ` — ${old.statement}` : ""}` : t("anmGone")}</p>
                <p><span className="text-xs text-muted-foreground">{t("anmNew")}: </span>{record.statement || record.title}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 px-2" data-testid={`anm-use-new-${record.id}`} onClick={() => void settle(record, old)}>{t("anmUseNew")}</Button>
                  <Button size="sm" variant="outline" className="h-7 px-2" data-testid={`anm-keep-old-${record.id}`} onClick={() => void ask({ op: "edit", id: record.id, patch: { status: "rejected" }, reason: "contradiction settled in the Anamnesis tab: the old statement stays" }).then(onChanged, (cause) => toast.error(errorText(cause)))}>{t("anmKeepOld")}</Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {rest.length ? rest.slice(0, shown).map((record) => <RecordRow key={record.id} record={record} ask={ask} byId={byId} onChanged={onChanged} />) : !contradictions.length ? <p className="text-sm text-muted-foreground">{t("anmNothingToReview")}</p> : null}
      {rest.length > shown ? <Button size="sm" variant="outline" onClick={() => setShown(shown + PAGE)}>{t("anmShowMore")}</Button> : null}
    </div>
  );
}

function RecordsView({ ask, records, byId, onChanged }: { ask: Ask; records: AnamnesisRecord[]; byId: Map<string, AnamnesisRecord>; onChanged: () => void }) {
  const [kind, setKind] = useState<Kind | "all">("all");
  const [state, setState] = useState<Status | "all">("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const needle = query.trim().toLowerCase();
  const rows = records.filter((record) => (kind === "all" || record.kind === kind) && (state === "all" || record.status === state)
    && (!needle || `${record.title} ${record.statement}`.toLowerCase().includes(needle)));
  return (
    <div className="space-y-3" data-testid="anm-records">
      <div className="flex flex-wrap items-center gap-2">
        <select className={SELECT_CLASS} aria-label={t("anmFilterKind")} value={kind} onChange={(event) => { setKind(event.target.value as Kind | "all"); setShown(PAGE); }}>
          <option value="all">{t("anmAllKinds")}</option>
          {KIND_LIST.map((value) => <option key={value} value={value}>{label(`anmKind_${value}`)}</option>)}
        </select>
        <select className={SELECT_CLASS} aria-label={t("anmFilterStatus")} value={state} onChange={(event) => { setState(event.target.value as Status | "all"); setShown(PAGE); }}>
          <option value="all">{t("anmAllStatuses")}</option>
          {STATUS_LIST.map((value) => <option key={value} value={value}>{label(`anmStatus_${value}`)}</option>)}
        </select>
        <Input className="h-8 min-w-32 flex-1" placeholder={t("anmSearch")} aria-label={t("anmSearch")} value={query} onChange={(event) => { setQuery(event.target.value); setShown(PAGE); }} />
      </div>
      <p className="text-xs text-muted-foreground">{rows.length} / {records.length}</p>
      {rows.slice(0, shown).map((record) => <RecordRow key={record.id} record={record} ask={ask} byId={byId} onChanged={onChanged} />)}
      {!rows.length ? <p className="text-sm text-muted-foreground">{t("anmNone")}</p> : null}
      {rows.length > shown ? <Button size="sm" variant="outline" onClick={() => setShown(shown + PAGE)}>{t("anmShowMore")}</Button> : null}
    </div>
  );
}

function SkillsView({ records }: { records: AnamnesisRecord[] }) {
  const skills = records.filter((record) => record.kind === "skill" && (record.status === "confirmed" || record.status === "draft"))
    .map((record) => ({ record, steps: stepsOf(record.attributes) })).sort((a, b) => Number(b.record.attributes.commits ?? 0) - Number(a.record.attributes.commits ?? 0));
  const months = skills.flatMap((skill) => skill.steps.map((step) => step.month)).sort();
  const from = months[0] ?? "", to = months.at(-1) ?? "";
  return (
    <div className="space-y-2" data-testid="anm-skills">
      <p className="text-xs text-muted-foreground">{t("anmSkillsHelp")}</p>
      {skills.length ? skills.map(({ record, steps }) => (
        <div key={record.id} className="space-y-1 rounded-lg border border-[var(--lp-hairline)] p-2.5 text-sm" data-testid={`anm-skill-${record.id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{record.title}</span>
            {steps.length ? <Badge variant="secondary">{label(`anmLevel_${steps.at(-1)!.level}`)}</Badge> : <Badge variant="outline">{t("anmNoLevel")}</Badge>}
            {record.status === "draft" ? <Badge variant="outline">{label("anmStatus_draft")}</Badge> : null}
          </div>
          {steps.length > 0 && from !== to ? <LevelChart steps={steps} from={from} to={to} /> : null}
          {steps.length ? <p className="text-xs text-muted-foreground">{steps.map((step) => `${step.month}: ${label(`anmLevel_${step.level}`)}`).join(" → ")}</p> : null}
        </div>
      )) : <p className="text-sm text-muted-foreground">{t("anmNone")}</p>}
    </div>
  );
}

function TimelineView({ records }: { records: AnamnesisRecord[] }) {
  const [by, setBy] = useState<"month" | "year">("month");
  const events = records.filter((record) => (record.kind === "event" || record.kind === "project") && (record.status === "confirmed" || record.status === "draft") && record.firstSeen)
    .sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0));
  const groups = new Map<string, AnamnesisRecord[]>();
  for (const record of events) { const key = new Date(record.firstSeen!).toISOString().slice(0, by === "month" ? 7 : 4); groups.set(key, [...(groups.get(key) ?? []), record]); }
  return (
    <div className="space-y-2" data-testid="anm-timeline">
      <label className="flex items-center gap-2 text-xs">{t("anmGroupBy")}
        <select className={SELECT_CLASS} value={by} onChange={(event) => setBy(event.target.value as "month" | "year")}>
          <option value="month">{t("anmByMonth")}</option>
          <option value="year">{t("anmByYear")}</option>
        </select>
      </label>
      {[...groups].map(([key, list]) => (
        <div key={key} className="space-y-1">
          <p className="text-sm font-medium">{key}</p>
          <ul className="space-y-0.5 text-sm">{list.map((record) => <li key={record.id} style={{ overflowWrap: "anywhere" }}>{day(record.firstSeen)} · <Badge variant="outline">{label(`anmKind_${record.kind}`)}</Badge> {record.title}</li>)}</ul>
        </div>
      ))}
      {!groups.size ? <p className="text-sm text-muted-foreground">{t("anmNone")}</p> : null}
    </div>
  );
}

const SOURCE_NOTES: Partial<Record<Source, I18nKey>> = { telegram: "anmSourceTelegram", elba: "anmSourceElba" };

function SourcesView({ ask, status, config, onConfig, onChanged }: { ask: Ask; status: ResponseOf<"status">; config: AnamnesisConfig; onConfig: (set: Record<string, unknown>) => Promise<void>; onChanged: () => void }) {
  const [channels, setChannels] = useState((config.telegramChannels ?? []).join(", "));
  const [ceiling, setCeiling] = useState(String(config.maxClassify ?? ""));
  const toggle = async (source: Exclude<Source, "manual">, enabled: boolean) => {
    try { await ask({ op: "sources", set: { source, enabled } }); onChanged(); } catch (cause) { toast.error(errorText(cause)); }
  };
  return (
    <div className="space-y-3" data-testid="anm-sources">
      <p className="text-xs text-muted-foreground">{t("anmSourcesHelp")}</p>
      {status.sources.map((source) => (
        <div key={source.source} className="space-y-1 rounded-lg border border-[var(--lp-hairline)] p-2.5" data-testid={`anm-source-${source.source}`}>
          <div className="flex items-center gap-2">
            <Switch checked={source.enabled} aria-label={label(`anmSource_${source.source.replace(/-/g, "_")}`)} data-testid={`anm-source-switch-${source.source}`} onCheckedChange={(checked) => void toggle(source.source, checked)} />
            <span className="min-w-0 flex-1 text-sm font-medium">{label(`anmSource_${source.source.replace(/-/g, "_")}`)}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{source.checkpoint ? `${t("anmReadUpTo")} ${day(source.checkpoint)}` : t("anmNeverRead")}</span>
            <ArmedButton testId={`anm-source-forget-${source.source}`} armedText={t("anmForgetSure")} onConfirm={() => void ask({ op: "forget", source: source.source }).then(onChanged, (cause) => toast.error(errorText(cause)))}>{t("anmForgetSource")}</ArmedButton>
          </div>
          {SOURCE_NOTES[source.source] ? <p className="text-xs text-muted-foreground">{label(SOURCE_NOTES[source.source]!)}</p> : null}
          {source.source === "telegram" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input className="h-8 min-w-40 flex-1" placeholder="@channel, @other" aria-label={t("anmTelegramChannels")} value={channels} data-testid="anm-telegram-channels" onChange={(event) => setChannels(event.target.value)} />
              <Button size="sm" variant="outline" onClick={() => void onConfig({ telegramChannels: channels.split(",").map((part) => part.trim()).filter(Boolean) })}>{t("anmSave")}</Button>
            </div>
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-2">{t("anmCeiling")}
          <Input className="h-8 w-24" inputMode="numeric" placeholder="200" value={ceiling} data-testid="anm-ceiling" onChange={(event) => setCeiling(event.target.value.replace(/\D/g, "").slice(0, 4))} />
        </label>
        <Button size="sm" variant="outline" onClick={() => { const n = Number(ceiling); if (Number.isInteger(n) && n >= 1 && n <= 2000) void onConfig({ maxClassify: n }); else toast.error(t("anmCeilingBad")); }}>{t("anmSave")}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("anmCeilingHelp")}</p>
      {status.cutoff ? <p className="text-xs text-muted-foreground">{t("anmCutoff")} {day(status.cutoff)}</p> : null}
    </div>
  );
}

function summaryOf(mode: string, report: Record<string, unknown>): string {
  const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
  if (mode === "daily") {
    const messages = record(report.messages), extract = record(messages.extract);
    return report.ran === false ? String(report.note ?? "") : t("anmReportDaily").replace("{messages}", String(messages.total ?? 0)).replace("{created}", String(extract.created ?? 0)).replace("{merged}", String(extract.merged ?? 0))
      .replace("{contradictions}", String(extract.contradictions ?? 0)).replace("{sources}", String(Array.isArray(report.hostSources) ? report.hostSources.length : 0));
  }
  const messages = record(report.messages);
  return t("anmReportLoad").replace("{messages}", String(messages.total ?? 0)).replace("{sources}", String(Array.isArray(report.hostSources) ? report.hostSources.length : 0));
}

function ReportsView({ ask }: { ask: Ask }) {
  const [loads, setLoads] = useState<ResponseOf<"loads">["loads"] | null>(null);
  useEffect(() => { void ask({ op: "loads", limit: 20 }).then((answer) => setLoads(answer.loads), () => setLoads([])); }, [ask]);
  return (
    <div className="space-y-2" data-testid="anm-reports">
      <p className="text-xs text-muted-foreground">{t("anmReportsHelp")}</p>
      {loads === null ? <p className="text-sm text-muted-foreground">{t("anmLoading")}</p> : loads.length ? loads.map((load) => (
        <Disclosure key={load.id} compact summary={`${new Date(load.at).toISOString().slice(0, 16).replace("T", " ")} · ${label(`anmReportMode_${load.mode}`) } — ${summaryOf(load.mode, load.report)}`} testId={`anm-report-${load.id}`}>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap pt-1 text-xs" style={{ overflowWrap: "anywhere" }}>{JSON.stringify(load.report, null, 1)}</pre>
        </Disclosure>
      )) : <p className="text-sm text-muted-foreground">{t("anmNone")}</p>}
    </div>
  );
}
