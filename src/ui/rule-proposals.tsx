import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRpc, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../contracts";
import { detectLocale, t, type I18nKey } from "../../i18n";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Disclosure } from "./disclosure";

type Proposal = {
  id: string; rule: string; author: "sweep" | "pm" | "owner" | "model"; state: "proposed" | "accepted" | "rejected" | "revoked";
  occurrences: number; taskCount: number; examples: string[]; evidence: Array<{ runId: string; taskId: string; attemptId: string; reason: string }>;
  lastSeenAt: number; decidedAt: number | null;
  decidedBy: "owner" | "auto" | null; trialState: "trial" | "confirmed" | null; revision: number; retiredReason: string | null;
  trial: { applied: number; appliedAccepted: number; recurrences: number } | null;
  scope: string[]; scopeLabel: string;
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

/**
 * Repeated writer failures the owner turns into project rules, and the rules already in force. Jev's sorting of
 * failed attempts is summarised on top; «Rescan» runs the sorting and the analyzer model on demand.
 */
export function RuleProposals({ projectId, picker }: {
  projectId: string;
  picker: (value: ExperimentalProviderModelPickerValue, onChange: (next: ExperimentalProviderModelPickerValue) => void) => ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [listed, setListed] = useState<Listed | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setListed(await rpc.call("list_rule_proposals", { projectId }) as Listed); } catch { setListed(null); }
  }, [projectId, rpc]);

  useEffect(() => { setDrafts({}); void load(); }, [load]);

  // While a scan runs the screen follows it; the scan itself lives on the server.
  const scanning = listed?.scan.state === "running";
  useEffect(() => {
    if (!scanning) return;
    const timer = setInterval(() => { void load(); }, 3_000);
    return () => clearInterval(timer);
  }, [scanning, load]);

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

  const saveAnalyzer = async (next: ExperimentalProviderModelPickerValue) => {
    try {
      await rpc.call("save_rules_analyzer", { projectId, analyzer: {
        providerId: next.providerId, model: next.model, reasoningLevel: next.reasoningLevel,
        serviceTier: next.serviceTier === "fast" ? "fast" : next.serviceTier === "default" ? "default" : null,
      } });
      await load();
    } catch (cause) {
      toast.error(t("rulesFailed"), { description: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const proposals = listed?.proposals ?? [];
  const pending = proposals.filter((row) => row.state === "proposed");
  const accepted = proposals.filter((row) => row.state === "accepted");
  const closed = proposals.filter((row) => row.state === "rejected" || row.state === "revoked");
  const memoryOn = listed ? listed.memory.enabled && listed.memory.inject : true;
  const scan = listed?.scan;
  const triage = listed?.triage;
  const analyzer = listed?.analyzer;

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
        <div className="text-xs font-medium">{t("rulesAnalyzer")}</div>
        <p className="text-xs text-muted-foreground">{t("rulesAnalyzerHelp")}</p>
        {picker(analyzer
          ? { providerId: analyzer.providerId, model: analyzer.model, reasoningLevel: analyzer.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"], ...(analyzer.serviceTier ? { serviceTier: analyzer.serviceTier } : {}) }
          : { providerId: "", model: "", reasoningLevel: "none" }, (next) => { void saveAnalyzer(next); })}
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
        {scan?.reason?.startsWith("jev_unavailable") ? <p className="text-xs text-amber-600">{t("rulesScanJevOff")}</p> : null}
      </div>

      {!memoryOn && (pending.length > 0 || accepted.length > 0) ? <p className="max-w-xl text-xs text-amber-600" data-testid="rules-memory-off">{t("rulesMemoryOff")}</p> : null}
      {listed && proposals.length === 0 ? <p className="text-xs text-muted-foreground">{t("rulesEmpty")}</p> : null}
      {pending.length > 0 ? <div className="space-y-2">
        <div className="text-xs font-medium">{t("rulesPending")}</div>
        {pending.map((proposal) => (
          <div key={proposal.id} className="max-w-xl space-y-2 rounded-md border border-border p-3" data-testid={`rule-${proposal.id}`}>
            {meta(proposal)}
            <textarea aria-label={t("rulesTitle")} className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-sm"
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
          <div key={proposal.id} className="flex max-w-xl items-start justify-between gap-2 rounded-md border border-border p-3" data-testid={`rule-${proposal.id}`}>
            <div className="min-w-0 space-y-1">
              <p className="text-sm" style={{ overflowWrap: "anywhere" }}>{proposal.rule}</p>
              {meta(proposal)}
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
