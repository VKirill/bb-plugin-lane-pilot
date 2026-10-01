import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../contracts";
import { t, type I18nKey } from "../../i18n";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Disclosure } from "./disclosure";

type Proposal = {
  id: string; rule: string; author: "sweep" | "pm" | "owner"; state: "proposed" | "accepted" | "rejected" | "revoked";
  occurrences: number; taskCount: number; examples: string[]; lastSeenAt: number; decidedAt: number | null;
};

const AUTHOR: Record<Proposal["author"], I18nKey> = { sweep: "rulesAuthorSweep", pm: "rulesAuthorPm", owner: "rulesAuthorOwner" };

/** Repeated writer failures the owner turns into project rules, and the rules already in force. */
export function RuleProposals({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [memoryOn, setMemoryOn] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const listed = await rpc.call("list_rule_proposals", { projectId }) as { proposals: Proposal[]; memory: { enabled: boolean; inject: boolean } };
      setProposals(listed.proposals);
      setMemoryOn(listed.memory.enabled && listed.memory.inject);
    } catch { setProposals([]); }
  }, [projectId, rpc]);

  useEffect(() => { setDrafts({}); void load(); }, [load]);

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

  const pending = proposals.filter((row) => row.state === "proposed");
  const accepted = proposals.filter((row) => row.state === "accepted");
  const closed = proposals.filter((row) => row.state === "rejected" || row.state === "revoked");

  const meta = (proposal: Proposal) => (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t("rulesTasks")}: {proposal.taskCount}</span>
      <Badge variant="outline">{t(AUTHOR[proposal.author])}</Badge>
    </div>
  );

  const examples = (proposal: Proposal) => proposal.examples.length > 0 ? (
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
      {!memoryOn && (pending.length > 0 || accepted.length > 0) ? <p className="max-w-xl text-xs text-amber-600" data-testid="rules-memory-off">{t("rulesMemoryOff")}</p> : null}
      {proposals.length === 0 ? <p className="text-xs text-muted-foreground">{t("rulesEmpty")}</p> : null}
      {pending.length > 0 ? <div className="space-y-2">
        <div className="text-xs font-medium">{t("rulesPending")}</div>
        {pending.map((proposal) => (
          <div key={proposal.id} className="max-w-xl space-y-2 rounded-md border border-border p-3" data-testid={`rule-${proposal.id}`}>
            {meta(proposal)}
            <textarea aria-label={t("rulesTitle")} className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-sm"
              style={{ overflowWrap: "anywhere" }} maxLength={600} value={drafts[proposal.id] ?? proposal.rule}
              onChange={(event) => setDrafts((current) => ({ ...current, [proposal.id]: event.target.value }))} />
            {examples(proposal)}
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
            </div>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void decide(proposal, "revoke")}>{t("rulesRevoke")}</Button>
          </div>
        ))}
      </div> : null}
      {closed.length > 0 ? <Disclosure compact summary={`${t("rulesClosed")} (${closed.length})`}>
        <ul className="max-w-xl space-y-1 text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
          {closed.map((proposal) => <li key={proposal.id}>{proposal.rule}</li>)}
        </ul>
      </Disclosure> : null}
    </section>
  );
}
