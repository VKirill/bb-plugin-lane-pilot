import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../contracts";
import { detectLocale, t, type I18nKey } from "../../i18n";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Disclosure } from "./disclosure";
import { useLpRealtime } from "./use-lp-realtime";

type Proposal = {
  id: string; rule: string; author: "sweep" | "pm" | "owner" | "model"; state: "proposed" | "accepted" | "rejected" | "revoked";
  occurrences: number; taskCount: number; examples: string[]; evidence: Array<{ runId: string; taskId: string; attemptId: string; reason: string }>;
  lastSeenAt: number; decidedAt: number | null;
  decidedBy: "owner" | "auto" | null; trialState: "trial" | "confirmed" | null; revision: number; retiredReason: string | null;
  trial: { applied: number; appliedAccepted: number; recurrences: number } | null;
  scope: string[]; scopeLabel: string;
  audience: "writer" | "pm" | "both"; always: boolean;
};
type Scan = { state: "idle" | "running" | "done" | "failed"; startedAt: number | null; finishedAt: number | null; triaged: number; groups: number; proposals: number; reason: string | null;
  adopted?: number; confirmed?: number; revised?: number; retired?: number };
type RuleEventRow = { ruleId: string; action: string; detail: string | null; at: number };
type Triage = { total: number; byOrigin: Record<string, number>; errors: number; lastTriagedAt: number | null; pendingGroups: number };
type Analyzer = { providerId: string; model: string; reasoningLevel: string; serviceTier: "default" | "fast" | null };
type Listed = { proposals: Proposal[]; memory: { enabled: boolean; inject: boolean }; triage: Triage; scan: Scan; analyzer: Analyzer | null; events: RuleEventRow[] };
const EVENT_LABEL: Record<string, I18nKey> = {
  adopted: "rulesEvent_adopted", confirmed: "rulesEvent_confirmed", revised: "rulesEvent_revised", retired: "rulesEvent_retired", cap_reached: "rulesEvent_cap_reached",
  owner_accepted: "rulesEvent_owner_accepted", owner_rejected: "rulesEvent_owner_rejected", owner_revoked: "rulesEvent_owner_revoked",
};

const AUTHOR: Record<Proposal["author"], I18nKey> = { sweep: "rulesAuthorSweep", pm: "rulesAuthorPm", owner: "rulesAuthorOwner", model: "rulesAuthorModel" };
const ORIGINS = ["writer", "orchestrator", "environment", "task", "unclear"] as const;
const ORIGIN_LABEL: Record<(typeof ORIGINS)[number], I18nKey> = {
  writer: "rulesOrigin_writer", orchestrator: "rulesOrigin_orchestrator", environment: "rulesOrigin_environment", task: "rulesOrigin_task", unclear: "rulesOrigin_unclear",
};

/** The model that sorts failures and writes rule proposals for a project, read from the rules listing and saved on its own. */
export function useRulesAnalyzer(projectId: string | null): {
  analyzer: ExperimentalProviderModelPickerValue | null; loaded: boolean; touched: { current: boolean };
  save: (next: ExperimentalProviderModelPickerValue) => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [analyzer, setAnalyzer] = useState<Analyzer | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The picker reports a normalized value on mount (a model missing from the catalog, an unsupported effort); only a
  // change the owner made by hand is saved, or opening the screen would silently replace the analyzer.
  const touched = useRef(false);
  useEffect(() => {
    if (!projectId) { setAnalyzer(null); setLoaded(true); return; }
    let live = true;
    setLoaded(false);
    void rpc.call("list_rule_proposals", { projectId }).then((listed) => { if (live) { setAnalyzer((listed as Listed).analyzer); setLoaded(true); } }).catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [projectId, rpc]);
  const save = async (next: ExperimentalProviderModelPickerValue) => {
    if (!touched.current || !projectId) return;
    try {
      const saved = await rpc.call("save_rules_analyzer", { projectId, analyzer: {
        providerId: next.providerId, model: next.model, reasoningLevel: next.reasoningLevel,
        serviceTier: next.serviceTier === "fast" ? "fast" : next.serviceTier === "default" ? "default" : null,
      } });
      setAnalyzer((saved as { analyzer: Analyzer }).analyzer);
    } catch (cause) {
      toast.error(t("rulesFailed"), { description: cause instanceof Error ? cause.message : String(cause) });
    }
  };
  return {
    analyzer: analyzer ? { providerId: analyzer.providerId, model: analyzer.model, reasoningLevel: analyzer.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"], ...(analyzer.serviceTier ? { serviceTier: analyzer.serviceTier } : {}) } : null,
    loaded, touched, save,
  };
}

/**
 * Repeated writer failures the owner turns into project rules, and the rules already in force. Jev's sorting of
 * failed attempts is summarised on top; «Rescan» runs the sorting and the analyzer model on demand.
 */
export function RuleProposals({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [listed, setListed] = useState<Listed | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setListed(await rpc.call("list_rule_proposals", { projectId }) as Listed); } catch { setListed(null); }
  }, [projectId, rpc]);

  useEffect(() => { setDrafts({}); void load(); }, [load]);

  // The server signals every scan step and every change of the rules (a decision on another device, a PM proposal);
  // while a scan runs the slow poll still checks it, and the scan itself lives on the server.
  const pollMs = useLpRealtime(projectId, ["rules"], () => { void load(); });
  const scanning = listed?.scan.state === "running";
  useEffect(() => {
    if (!scanning) return;
    const timer = setInterval(() => { void load(); }, pollMs);
    return () => clearInterval(timer);
  }, [scanning, load, pollMs]);

  const decide = async (proposal: Proposal, action: "accept" | "reject" | "revoke") => {
    setBusy(proposal.id);
    try {
      const rule = (drafts[proposal.id] ?? proposal.rule).trim();
      await rpc.call("decide_rule_proposal", { projectId, id: proposal.id, action, ...(action === "accept" ? { rule } : {}) });
      toast.success(t("rulesSaved"));
      await load();
    } catch (cause) {
      toast.error(t("rulesFailed"), { description: cause instanceof Error ? cause.message : String(cause) });
    } finally { setBusy(null); }
  };

  const rescan = async () => {
    try {
      await rpc.call("start_rule_scan", { projectId, locale: detectLocale() === "ru" ? "ru" : "en" });
      await load();
    } catch (cause) {
      toast.error(t("rulesScanFailed"), { description: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const proposals = listed?.proposals ?? [];
  const pending = proposals.filter((row) => row.state === "proposed");
  const accepted = proposals.filter((row) => row.state === "accepted");
  const closed = proposals.filter((row) => row.state === "rejected" || row.state === "revoked");
  const memoryOn = listed ? listed.memory.enabled && listed.memory.inject : true;
  const scan = listed?.scan;
  const triage = listed?.triage;

  const meta = (proposal: Proposal) => (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Badge variant="outline" data-testid={`rule-scope-${proposal.id}`}>{proposal.scopeLabel || t("rulesScopeProject")}</Badge>
      <span>{t("rulesTasks")}: {proposal.taskCount}</span>
      <Badge variant="outline">{t(AUTHOR[proposal.author])}</Badge>
      {proposal.state === "accepted" ? <Badge variant={proposal.trialState === "trial" ? "secondary" : "outline"}>
        {proposal.decidedBy === "auto" ? (proposal.trialState === "trial" ? t("rulesTrial") : t("rulesConfirmed")) : t("rulesByOwner")}
      </Badge> : null}
      {proposal.decidedBy === "auto" && proposal.state === "accepted" ? <span>{t("rulesByAuto")}</span> : null}
      {proposal.revision > 1 ? <span>{t("rulesRevision")} {proposal.revision}</span> : null}
      {proposal.trial ? <span data-testid={`rule-trial-${proposal.id}`}>{t("rulesApplied")}: {proposal.trial.applied} · {t("rulesRecurred")}: {proposal.trial.recurrences}</span> : null}
    </div>
  );
  // Who the rule is for: a PM rule never reaches a writer, an «every task» rule skips System One's per-task pick.
  const setAudience = async (proposal: Proposal, audience: Proposal["audience"], always: boolean) => {
    // Shown at once; the list reloads from the server either way, so a failed save puts the old value back.
    setListed((current) => current ? { ...current, proposals: current.proposals.map((row) => row.id === proposal.id ? { ...row, audience, always } : row) } : current);
    try { await rpc.call("rule_set_audience", { projectId, ruleId: proposal.id, audience, always }); }
    catch (cause) { toast.error(t("rulesFailed"), { description: cause instanceof Error ? cause.message : String(cause) }); }
    await load();
  };
  const audienceControls = (proposal: Proposal) => (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" data-testid={`rule-audience-${proposal.id}`}>
      <label className="flex items-center gap-1">
        <span>{t("rulesAudience")}:</span>
        <select className="h-7 rounded-md border border-input bg-background px-1 text-xs text-foreground" value={proposal.audience}
          data-testid={`rule-audience-select-${proposal.id}`}
          onChange={(event) => void setAudience(proposal, event.target.value as Proposal["audience"], event.target.value === "pm" ? false : proposal.always)}>
          {(["writer", "pm", "both"] as const).map((value) => <option key={value} value={value}>{t(`rulesAudience_${value}` as I18nKey)}</option>)}
        </select>
      </label>
      {proposal.audience !== "pm" ? (
        <label className="flex items-center gap-1" title={t("rulesAlwaysHint")}>
          <input type="checkbox" checked={proposal.always} data-testid={`rule-always-${proposal.id}`}
            onChange={(event) => void setAudience(proposal, proposal.audience, event.target.checked)} />
          <span>{t("rulesAlways")}</span>
        </label>
      ) : null}
    </div>
  );
  const ruleText = (id: string) => proposals.find((row) => row.id === id)?.rule ?? id;

  const evidence = (proposal: Proposal) => proposal.evidence.length > 0 ? (
    <Disclosure compact summary={`${t("rulesEvidence")} (${proposal.evidence.length})`}>
      <ul className="space-y-1 text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }} data-testid={`rule-evidence-${proposal.id}`}>
        {proposal.evidence.map((row) => <li key={row.attemptId}><span className="font-mono">{row.taskId}</span>: {row.reason}</li>)}
      </ul>
    </Disclosure>
  ) : proposal.examples.length > 0 ? (
    <Disclosure compact summary={t("rulesExamples")}>
      <ul className="space-y-1 text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
        {proposal.examples.map((example) => <li key={example}>{example}</li>)}
      </ul>
    </Disclosure>
  ) : null;

  return (
    <section className="space-y-3" data-testid="rule-proposals">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("rulesTitle")}</h3>
        <p className="max-w-xl text-xs text-muted-foreground">{t("rulesHelp")}</p>
      </div>

      {triage && triage.total > 0 ? (
        <div className="max-w-xl space-y-1 text-xs" data-testid="rules-triage">
          <div className="font-medium">{t("rulesTriageTitle")}: {triage.total}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
            {ORIGINS.filter((origin) => triage.byOrigin[origin]).map((origin) => <span key={origin}>{t(ORIGIN_LABEL[origin])}: {triage.byOrigin[origin]}</span>)}
            {triage.errors > 0 ? <span>{t("rulesTriageErrors")}: {triage.errors}</span> : null}
          </div>
          {triage.pendingGroups > 0 ? <div className="text-muted-foreground">{t("rulesGroupsPending")}: {triage.pendingGroups}</div> : null}
        </div>
      ) : null}

      <div className="max-w-xl space-y-2">
        <p className="text-xs text-muted-foreground" data-testid="rules-analyzer-note">{t("rulesAnalyzerWhere")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={scanning || !listed} onClick={() => void rescan()}>{scanning ? t("rulesScanRunning") : t("rulesScan")}</Button>
          {scan && scan.state !== "idle" && scan.state !== "running" ? (
            <span className="text-xs text-muted-foreground" data-testid="rules-scan-result">
              {scan.state === "failed"
                ? `${t("rulesScanFailed")}: ${scan.reason ?? ""}`
                : `${t("rulesScanLast")}: ${t("rulesScanTriaged")} ${scan.triaged}, ${t("rulesScanGroups")} ${scan.groups}, ${t("rulesScanProposals")} ${scan.proposals}`
                  + `, ${t("rulesScanAdopted")} ${scan.adopted ?? 0}, ${t("rulesScanTrial")} ${scan.confirmed ?? 0}, ${t("rulesScanRevisedShort")} ${scan.revised ?? 0}, ${t("rulesScanRetiredShort")} ${scan.retired ?? 0}`}
            </span>
          ) : null}
        </div>
        {scan?.reason?.startsWith("jev_unavailable") ? <p className="text-xs lp-text-warning">{t("rulesScanJevOff")}</p> : null}
      </div>

      {!memoryOn && (pending.length > 0 || accepted.length > 0) ? <p className="max-w-xl text-xs lp-text-warning" data-testid="rules-memory-off">{t("rulesMemoryOff")}</p> : null}
      {listed && proposals.length === 0 ? <p className="text-xs text-muted-foreground">{t("rulesEmpty")}</p> : null}
      {pending.length > 0 ? <div className="space-y-2">
        <div className="text-xs font-medium">{t("rulesPending")}</div>
        {pending.map((proposal) => (
          <div key={proposal.id} className="lp-card max-w-xl space-y-2 p-3" data-testid={`rule-${proposal.id}`}>
            {meta(proposal)}
            {audienceControls(proposal)}
            <textarea aria-label={t("rulesTitle")} className="min-h-20 w-full rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] p-2 text-sm"
              style={{ overflowWrap: "anywhere" }} maxLength={600} value={drafts[proposal.id] ?? proposal.rule}
              onChange={(event) => setDrafts((current) => ({ ...current, [proposal.id]: event.target.value }))} />
            {evidence(proposal)}
            <div className="flex gap-2">
              <Button size="sm" disabled={busy !== null || (drafts[proposal.id] ?? proposal.rule).trim().length < 8} onClick={() => void decide(proposal, "accept")}>{t("rulesAccept")}</Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void decide(proposal, "reject")}>{t("rulesReject")}</Button>
            </div>
          </div>
        ))}
      </div> : null}
      {accepted.length > 0 ? <div className="space-y-2">
        <div className="text-xs font-medium">{t("rulesAccepted")}</div>
        {accepted.map((proposal) => (
          <div key={proposal.id} className="lp-card flex max-w-xl items-start justify-between gap-2 p-3" data-testid={`rule-${proposal.id}`}>
            <div className="min-w-0 space-y-1">
              <p className="text-sm" style={{ overflowWrap: "anywhere" }}>{proposal.rule}</p>
              {meta(proposal)}
              {audienceControls(proposal)}
              {evidence(proposal)}
            </div>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void decide(proposal, "revoke")}>{t("rulesRevoke")}</Button>
          </div>
        ))}
      </div> : null}
      {(listed?.events?.length ?? 0) > 0 ? <Disclosure compact summary={`${t("rulesJournal")} (${listed!.events.length})`}>
        <ul className="max-w-xl space-y-1 text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }} data-testid="rules-journal">
          {listed!.events.map((event, index) => <li key={`${event.at}-${index}`}>
            {new Date(event.at).toLocaleString()} · {EVENT_LABEL[event.action] ? t(EVENT_LABEL[event.action]!) : event.action}{event.detail ? ` (${event.detail})` : ""}: {ruleText(event.ruleId).slice(0, 140)}
          </li>)}
        </ul>
      </Disclosure> : null}
      {closed.length > 0 ? <Disclosure compact summary={`${t("rulesClosed")} (${closed.length})`}>
        <ul className="max-w-xl space-y-1 text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
          {closed.map((proposal) => <li key={proposal.id}>{proposal.rule}</li>)}
        </ul>
      </Disclosure> : null}
    </section>
  );
}
