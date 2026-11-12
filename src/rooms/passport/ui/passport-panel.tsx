import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Badge, Button, Disclosure, Input } from "@lane-pilot/ui-kit";
import { Pill, useLpRealtime } from "../../ui-shell/ui";
import type { passportRpcMethods } from "../contract";
import {
  PASSPORT_SECTIONS,
  PASSPORT_STAGES,
  formatClaimValue,
  isClaimEnvelope,
  type ClaimStatus,
  type PassportContradiction,
  type PassportMetrics,
  type PassportQuestion,
  type PassportSectionId,
  type PassportStage,
  type PassportV1,
  type PendingPassportDelta,
  type VerbatimEntry,
} from "../schema";

interface PassportPayload {
  exists: boolean;
  projectId: string;
  scopeKey: string;
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
  passport: PassportV1;
  passportMd: string;
  metrics: PassportMetrics;
  verbatim: VerbatimEntry[];
  pending: PendingPassportDelta[];
  contradictions: PassportContradiction[];
  nextQuestions: PassportQuestion[];
}

const SECTION_LABEL_KEYS: Record<PassportSectionId, I18nKey> = {
  identity: "ppSec_identity",
  market_rails: "ppSec_market_rails",
  positioning: "ppSec_positioning",
  audience_jtbd: "ppSec_audience_jtbd",
  messaging_voice: "ppSec_messaging_voice",
  economics_funnel: "ppSec_economics_funnel",
  proof_brandcore: "ppSec_proof_brandcore",
  product_design_rails: "ppSec_product_design_rails",
};

const SELECT_CLASS = "h-8 rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] px-2 text-xs";

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusBadge(status: ClaimStatus) {
  if (status === "confirmed") return <Pill tone="success">{t("ppConfirmed")}</Pill>;
  if (status === "hypothesis") return <Pill tone="warning">{t("ppHypothesis")}</Pill>;
  if (status === "taboo") return <Pill tone="danger">{t("ppTaboo")}</Pill>;
  return <Pill tone="muted">{t("ppUnknown")}</Pill>;
}

function renderSectionRows(sectionObj: Record<string, unknown>) {
  const entries = Object.entries(sectionObj).filter(([, val]) => isClaimEnvelope(val));
  return entries.map(([field, rawClaim]) => {
    const claim = rawClaim as { status: ClaimStatus; value: unknown; note?: string };
    const formatted = formatClaimValue(claim.value);
    return (
      <div key={field} className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border/50 p-2 text-xs">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="font-medium text-foreground">{field}</div>
          <div className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
            {formatted || "—"}
          </div>
          {claim.note ? <div className="text-[11px] text-muted-foreground/80">{claim.note}</div> : null}
        </div>
        <div className="shrink-0">{statusBadge(claim.status)}</div>
      </div>
    );
  });
}

export function PassportPanel({ projectId, scopeKey = "" }: { projectId: string; scopeKey?: string }) {
  const rpc = useRpc<typeof passportRpcMethods>();
  const [data, setData] = useState<PassportPayload | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [oneLiner, setOneLiner] = useState("");
  const [stage, setStage] = useState<PassportStage>("unknown");
  const [countries, setCountries] = useState("");
  const [excludedCountries, setExcludedCountries] = useState("");
  const [uiLocales, setUiLocales] = useState("");
  const [contentLocales, setContentLocales] = useState("");
  const [currency, setCurrency] = useState("");
  const [payments, setPayments] = useState("");
  const [legalRegime, setLegalRegime] = useState("");
  const [ownerNote, setOwnerNote] = useState("");

  const hydrateDraft = useCallback((p: PassportV1) => {
    setName(p.identity.project_name.value);
    setOneLiner(p.identity.one_liner.value);
    setStage(p.identity.stage.value);
    setCountries(p.market_rails.primary_countries.value.join(", "));
    setExcludedCountries(p.market_rails.excluded_countries.value.join(", "));
    setUiLocales(p.market_rails.ui_locales.value.join(", "));
    setContentLocales(p.market_rails.content_locales.value.join(", "));
    setCurrency(p.market_rails.currency.value);
    setPayments(p.market_rails.payment_rails.value.join(", "));
    setLegalRegime(p.market_rails.compliance_regimes.value.join(", "));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = (await rpc.call("passport_get", { projectId, scopeKey })) as PassportPayload;
      setData(res);
      hydrateDraft(res.passport);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }, [hydrateDraft, projectId, rpc, scopeKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useLpRealtime(projectId, ["rules", "workflow"], () => {
    void load();
  });

  const saveRails = async () => {
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {
        identity: {
          ...(name.trim() ? { project_name: { status: "confirmed", value: name.trim() } } : {}),
          ...(oneLiner.trim() ? { one_liner: { status: "confirmed", value: oneLiner.trim() } } : {}),
          ...(stage !== "unknown" ? { stage: { status: "confirmed", value: stage } } : {}),
        },
        market_rails: {
          ...(splitCsv(countries).length ? { primary_countries: { status: "confirmed", value: splitCsv(countries).map((c) => c.toUpperCase()) } } : {}),
          ...(splitCsv(excludedCountries).length ? { excluded_countries: { status: "taboo", value: splitCsv(excludedCountries).map((c) => c.toUpperCase()) } } : {}),
          ...(splitCsv(uiLocales).length ? { ui_locales: { status: "confirmed", value: splitCsv(uiLocales) } } : {}),
          ...(splitCsv(contentLocales).length ? { content_locales: { status: "confirmed", value: splitCsv(contentLocales) } } : {}),
          ...(currency.trim() ? { currency: { status: "confirmed", value: currency.trim().toUpperCase() } } : {}),
          ...(splitCsv(payments).length ? { payment_rails: { status: "confirmed", value: splitCsv(payments) } } : {}),
          ...(splitCsv(legalRegime).length ? { compliance_regimes: { status: "confirmed", value: splitCsv(legalRegime) } } : {}),
        },
      };
      await rpc.call("passport_save", {
        projectId,
        scopeKey,
        patch,
        ...(ownerNote.trim() ? { ownerVerbatim: ownerNote.trim() } : {}),
      });
      setOwnerNote("");
      toast.success(t("ppSaved"));
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const decideDelta = async (deltaId: string, decision: "accept" | "reject") => {
    setBusy(true);
    try {
      await rpc.call("passport_decide", { projectId, deltaId, decision });
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async (kind: "express" | "deep") => {
    const promptText = kind === "express" ? t("ppPromptExpressText") : t("ppPromptDeepText");
    try {
      await navigator.clipboard.writeText(promptText);
      toast.success(t("ppPromptCopied"));
    } catch {
      toast.info(promptText);
    }
  };

  if (!data) {
    return (
      <div className="space-y-2 text-xs text-muted-foreground" data-testid="passport-panel-loading">
        {t("ppLoading")}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="passport-panel">
      <div className="space-y-2 rounded-lg border border-border/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">{t("ppTitle")}</h3>
            <p className="max-w-2xl text-xs text-muted-foreground">{t("ppSubtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" data-testid="passport-copy-express" onClick={() => void copyPrompt("express")}>
              {t("ppCopyPromptExpress")}
            </Button>
            <Button size="sm" variant="default" data-testid="passport-copy-deep" onClick={() => void copyPrompt("deep")}>
              {t("ppCopyPromptDeep")}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
          <Badge variant="secondary" data-testid="passport-completeness">
            {t("ppCompleteness")}: {data.metrics.completeness_score}%
          </Badge>
          <Pill tone="success">
            {t("ppConfirmed")}: {data.metrics.confirmed_count}
          </Pill>
          <Pill tone="warning">
            {t("ppHypothesis")}: {data.metrics.hypothesis_count}
          </Pill>
          <Pill tone="muted">
            {t("ppUnknown")}: {data.metrics.unknown_count}
          </Pill>
          <Pill tone="danger">
            {t("ppTaboo")}: {data.metrics.taboo_count}
          </Pill>
          <span className="text-muted-foreground">
            {t("ppVersion")}: v{data.version}
          </span>
        </div>

        {!data.exists ? <p className="pt-1 text-xs text-amber-600 dark:text-amber-400">{t("ppEmptyHint")}</p> : null}
      </div>

      {data.pending.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3" data-testid="passport-pending">
          <h4 className="text-xs font-semibold">{t("ppPendingTitle")}</h4>
          {data.pending.map((item) => (
            <div key={item.id} className="space-y-1.5 rounded-md border border-border/60 bg-background p-2 text-xs">
              <div className="font-medium">{item.field_path}</div>
              <div className="text-muted-foreground">
                {formatClaimValue(item.old_claim.value)} → <span className="font-semibold text-foreground">{formatClaimValue(item.proposed_claim.value)}</span>
              </div>
              {item.reason ? <blockquote className="border-l-2 border-border pl-2 italic text-muted-foreground">{item.reason}</blockquote> : null}
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="default" disabled={busy} onClick={() => void decideDelta(item.id, "accept")}>
                  {t("ppAccept")}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void decideDelta(item.id, "reject")}>
                  {t("ppReject")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {data.contradictions.length > 0 ? (
        <div className="space-y-1.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs" data-testid="passport-contradictions">
          <h4 className="font-semibold text-destructive">{t("ppContradictionsTitle")}</h4>
          {data.contradictions.map((c) => (
            <div key={`${c.code}-${c.fields}`} className="text-muted-foreground">
              <span className="font-medium text-foreground">[{c.severity}]</span> {c.detail}
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-3 rounded-lg border border-border/60 p-3" data-testid="passport-quick-rails">
        <h4 className="text-xs font-semibold">{t("ppQuickRailsTitle")}</h4>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("ppProjectName")}</span>
            <Input className="h-8 text-xs" value={name} data-testid="pp-input-name" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("ppStage")}</span>
            <select className={`${SELECT_CLASS} w-full`} value={stage} data-testid="pp-select-stage" onChange={(e) => setStage(e.target.value as PassportStage)}>
              {PASSPORT_STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs sm:col-span-2">
            <span className="text-muted-foreground">{t("ppOneLiner")}</span>
            <Input className="h-8 text-xs" value={oneLiner} data-testid="pp-input-oneliner" onChange={(e) => setOneLiner(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("ppCountries")}</span>
            <Input className="h-8 text-xs" placeholder="US, GB, CA" value={countries} data-testid="pp-input-countries" onChange={(e) => setCountries(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("ppExcludedCountries")}</span>
            <Input className="h-8 text-xs" placeholder="RU, BY" value={excludedCountries} data-testid="pp-input-excluded" onChange={(e) => setExcludedCountries(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("ppUiLocales")}</span>
            <Input className="h-8 text-xs" placeholder="en-US" value={uiLocales} data-testid="pp-input-ui-locales" onChange={(e) => setUiLocales(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("ppContentLocales")}</span>
            <Input className="h-8 text-xs" placeholder="en-US" value={contentLocales} data-testid="pp-input-content-locales" onChange={(e) => setContentLocales(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("ppCurrency")}</span>
            <Input className="h-8 text-xs" placeholder="USD" value={currency} data-testid="pp-input-currency" onChange={(e) => setCurrency(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">{t("ppPayments")}</span>
            <Input className="h-8 text-xs" placeholder="Stripe, Paddle" value={payments} data-testid="pp-input-payments" onChange={(e) => setPayments(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs sm:col-span-2">
            <span className="text-muted-foreground">{t("ppLegalRegime")}</span>
            <Input className="h-8 text-xs" placeholder="GDPR, CCPA, SOC2" value={legalRegime} data-testid="pp-input-legal" onChange={(e) => setLegalRegime(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs sm:col-span-2">
            <span className="text-muted-foreground">{t("ppOwnerNote")}</span>
            <Input className="h-8 text-xs" value={ownerNote} data-testid="pp-input-note" onChange={(e) => setOwnerNote(e.target.value)} />
          </label>
        </div>
        <Button size="sm" disabled={busy} data-testid="pp-save-rails" onClick={() => void saveRails()}>
          {t("ppSaveRails")}
        </Button>
      </div>

      {data.nextQuestions.length > 0 ? (
        <Disclosure compact summary={`${t("ppNextQuestionsTitle")} (${data.nextQuestions.length})`} testId="passport-next-questions">
          <div className="space-y-2 pt-2 text-xs">
            {data.nextQuestions.map((q) => (
              <div key={q.id} className="space-y-0.5 rounded-md border border-border/50 p-2">
                <div className="font-medium text-foreground">{q.question_ru}</div>
                <div className="text-[11px] text-muted-foreground">
                  {q.framework} · {q.field_path}
                </div>
              </div>
            ))}
          </div>
        </Disclosure>
      ) : null}

      <div className="space-y-2" data-testid="passport-sections">
        <h4 className="text-xs font-semibold">{t("ppSectionsTitle")}</h4>
        {PASSPORT_SECTIONS.map((sec) => {
          const secScore = data.metrics.section_scores[sec] ?? 0;
          const secRecord = data.passport[sec] as unknown as Record<string, unknown>;
          return (
            <Disclosure key={sec} compact summary={`${t(SECTION_LABEL_KEYS[sec])} · ${secScore}%`} testId={`passport-sec-${sec}`}>
              <div className="space-y-1.5 pt-2">{renderSectionRows(secRecord)}</div>
            </Disclosure>
          );
        })}
      </div>

      <Disclosure compact summary={`${t("ppVerbatimTitle")} (${data.verbatim.length})`} testId="passport-verbatim">
        <div className="space-y-2 pt-2 text-xs">
          {data.verbatim.length > 0 ? (
            data.verbatim.map((entry) => (
              <div key={entry.id} className="space-y-1 rounded-md border border-border/50 p-2">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <Badge variant="outline">{entry.id}</Badge>
                  <span>{entry.source}</span>
                  <span>{new Date(entry.created_at).toISOString().slice(0, 16).replace("T", " ")}</span>
                </div>
                {entry.question_asked ? <div className="font-medium text-muted-foreground">Q: {entry.question_asked}</div> : null}
                <blockquote className="border-l-2 border-primary/50 pl-2 text-foreground" style={{ overflowWrap: "anywhere" }}>
                  {entry.owner_verbatim}
                </blockquote>
              </div>
            ))
          ) : (
            <p className="text-muted-foreground">{t("ppVerbatimEmpty")}</p>
          )}
        </div>
      </Disclosure>
    </div>
  );
}
