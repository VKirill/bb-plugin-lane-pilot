import { useEffect, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey } from "@lane-pilot/i18n";
import type { z } from "zod";
import type { rpcContract } from "../../contracts";

type Card = NonNullable<z.infer<(typeof rpcContract)["task_acceptance_card"]["output"]>>;
type Item = NonNullable<Card["planFact"]>["items"][number];

/**
 * The acceptance card (SMA plan P1-4): one block in the task card that says why the task was accepted or not and on what proof — the
 * contract, the plan→fact table with the blind check's verdicts, each stage's receipt with what decided it (code or a model's
 * opinion), the gate events, the base commit, the risk and the cost. What did not run is listed on its own and says so: «not run» is not
 * «no findings», and a cost that was not measured is not zero.
 */
const fill = (key: I18nKey, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
const stageName = (id: string) => { const key = `stage_${id.replace(/-/g, "_")}` as I18nKey; const text = t(key); return text === key ? id : text; };
const stageState = (state: string) => { const key = `stage_state_${state}` as I18nKey; const text = t(key); return text === key ? state : text; };
const chip = "inline-flex max-w-full items-center gap-1 rounded-md border border-border px-1.5 text-[11px] leading-5 text-muted-foreground";
const OK = "text-[var(--color-success,#16a34a)]";
const BAD = "text-destructive";
const WARN = "text-[var(--color-attention,#d97706)]";

function Mark({ tone, children, label }: { tone: "ok" | "bad" | "warn" | "none"; children: ReactNode; label: string }) {
  const color = tone === "ok" ? OK : tone === "bad" ? BAD : tone === "warn" ? WARN : "text-muted-foreground";
  return <span role="img" aria-label={label} className={`inline-block w-4 shrink-0 text-center font-semibold ${color}`}>{children}</span>;
}

const itemMark = (item: Item) => item.severity === "blocking" ? <Mark tone="bad" label={t("acc_verdict_blocking")}>✗</Mark>
  : item.severity === "warning" ? <Mark tone="warn" label={t("acc_verdict_warning")}>✓</Mark> : <Mark tone="ok" label={t("acc_verdict_proven")}>✓</Mark>;

function Block({ title, testId, children }: { title: string; testId?: string; children: ReactNode }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <div className="mb-1.5 text-xs font-semibold text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

export function AcceptanceCard({ runId, taskId, fallback, finished, refreshKey }: {
  runId: string; taskId: string; refreshKey: unknown; finished: boolean;
  /** What the task page already knows of the contract, shown when the card cannot be read. */
  fallback: { objective: string | null; acceptance: string[] } | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [card, setCard] = useState<Card | null | "gone">(null);
  useEffect(() => {
    let live = true;
    void rpc.call("task_acceptance_card", { runId, taskId }).then((result) => { if (live) setCard(result ?? "gone"); }).catch(() => { if (live) setCard("gone"); });
    return () => { live = false; };
  }, [rpc, runId, taskId, refreshKey]);

  if (card === null || card === "gone") {
    if (!fallback) return null;
    return (
      <section className="mt-4" data-testid="acceptance-card-fallback">
        {fallback.objective ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{fallback.objective}</p> : null}
        {fallback.acceptance.length ? (
          <ul className="mt-3 space-y-1">{fallback.acceptance.map((row, index) => (
            <li key={index} className="flex items-start gap-2 text-sm"><Mark tone={finished ? "ok" : "none"} label="">{finished ? "✓" : "○"}</Mark><span className="min-w-0 break-words">{row}</span></li>
          ))}</ul>
        ) : null}
      </section>
    );
  }

  const pf = card.planFact;
  const rows = pf && pf.table === "ok" ? pf.items : [];
  const cost = card.cost;
  const usd = cost.usd === null ? null : `$${cost.usd.toFixed(cost.usd < 1 ? 3 : 2)}`;
  return (
    <section className="mt-5 rounded-lg border border-border bg-card p-3 shadow-2xs @3xl:p-4" data-testid="acceptance-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-sm font-semibold">{t("acc_title")}</h2>
        <span className="flex flex-wrap gap-1.5">
          {card.risk ? <span className={chip} data-testid="acc-risk">{t("acc_risk")}: {card.risk}</span> : null}
          <span className={chip} data-testid="acc-base" title={card.base?.sha ?? undefined}>
            {t("acc_base")}: {card.base?.sha ? `${card.base.sha.slice(0, 8)}${card.base.branch ? ` · ${card.base.branch}` : ""}` : t("acc_base_none")}
          </span>
          <span className={chip} data-testid="acc-cost" title={cost.note ?? undefined}>
            {t("acc_cost")}: {cost.state === "not_measured" ? t("acc_cost_not_measured")
              : cost.state === "measured" ? usd : fill("acc_cost_partial", { usd: usd ?? t("acc_cost_not_measured"), m: cost.measured, n: cost.attempts })}
          </span>
        </span>
      </div>

      {card.contract.objective ? <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed" data-testid="acc-objective">{card.contract.objective}</p> : null}

      <div className="mt-3">
        <Block title={t("acc_planfact")} testId="acc-planfact">
          {pf ? (
            <p className={`mb-1.5 text-xs ${pf.mode === "gate" ? "text-foreground" : "text-muted-foreground"}`}>{pf.mode === "gate" ? t("acc_mode_gate") : t("acc_mode_record")}</p>
          ) : null}
          {!pf || pf.table !== "ok" ? (
            <p className={`mb-1.5 break-words rounded-md border border-[var(--color-attention,#d97706)]/50 bg-[var(--color-attention,#d97706)]/5 px-2 py-1 text-xs ${WARN}`} data-testid="acc-planfact-notrun">
              <strong>{t("acc_not_run")}</strong> {pf ? pf.reason ?? t("acc_pf_no_table") : t("acc_pf_no_receipt")}
            </p>
          ) : null}
          <ul className="space-y-2">
            {(rows.length ? rows : card.contract.acceptance.map((text, index): Item | null => (text ? { item: index + 1, acceptance: text, claimed: "none", verdict: "no_row", severity: "info", evidence: [], why: null } : null)).filter((row): row is Item => row !== null)).map((item) => (
              <li key={item.item} className="text-sm" data-testid={`acc-item-${item.item}`} data-verdict={rows.length ? item.verdict : "not_checked"}>
                <div className="flex items-start gap-2">
                  {rows.length ? itemMark(item) : <Mark tone="none" label={t("acc_not_run")}>–</Mark>}
                  <span className="min-w-0 break-words">{item.acceptance}</span>
                </div>
                {rows.length ? (
                  <div className="ml-6 mt-0.5 space-y-0.5 text-xs">
                    <div className={item.severity === "blocking" ? BAD : "text-muted-foreground"}>{t(`acc_verdict_${item.verdict}` as I18nKey)}{item.why ? ` · ${item.why}` : ""}</div>
                    {item.evidence.map((entry, index) => (
                      <div key={index} className="flex min-w-0 items-start gap-1.5 font-mono" data-ok={entry.ok}>
                        <Mark tone={entry.ok ? (entry.code === "lines_unchecked" ? "warn" : "ok") : "bad"} label={entry.ok ? "ok" : "fail"}>{entry.ok ? "✓" : "✗"}</Mark>
                        <span className="min-w-0 break-words"><span className="break-all">{entry.evidence}</span> <span className="font-sans text-muted-foreground">· {entry.note}</span></span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {pf && pf.extraRows.length ? <p className="mt-1.5 text-xs text-muted-foreground">{fill("acc_extra_rows", { items: pf.extraRows.join(", ") })}</p> : null}
        </Block>
      </div>

      {card.contract.ownsPaths.length ? (
        <div className="mt-3">
          <Block title={t("acc_owns")} testId="acc-owns">
            <ul className="flex flex-wrap gap-1.5 font-mono text-[11px]">{card.contract.ownsPaths.map((path) => <li key={path} className={`${chip} break-all`}>{path}</li>)}</ul>
          </Block>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 @3xl:grid-cols-2">
        <Block title={t("acc_receipts")} testId="acc-receipts">
          {card.receipts.length ? (
            <ul className="space-y-1.5">
              {card.receipts.map((row) => (
                <li key={row.stageId} className="text-sm" data-testid={`acc-receipt-${row.stageId}`} data-proof={row.proof}>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{stageName(row.stageId)}</span>
                    <span className={`text-xs ${row.state === "passed" ? OK : row.state === "failed" || row.state === "blocked" ? BAD : "text-muted-foreground"}`}>{stageState(row.state)}</span>
                    <span className={`${chip} ${row.proof === "advisory" ? WARN : ""}`} title={row.proofKind}>{row.proof === "code" ? `${t("acc_proof_code")} · ${row.proofKind}` : t("acc_proof_advisory")}</span>
                  </div>
                  {row.reason ? <div className="break-words text-xs text-muted-foreground">{row.reason}</div> : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-muted-foreground">{t("acc_none")}</p>}
        </Block>
        <Block title={t("acc_gates")} testId="acc-gates">
          {card.gates.length ? (
            <ul className="space-y-1 text-sm">
              {card.gates.map((row, index) => (
                <li key={index} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{row.gate}</span>
                  <span className={`text-xs ${row.status === "passed" ? OK : row.status === "skipped" ? "text-muted-foreground" : BAD}`}>{row.status}</span>
                  <span className="text-xs text-muted-foreground">{fill("acc_attempt_n", { n: row.attempt })}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-muted-foreground">{t("acc_none")}</p>}
        </Block>
      </div>

      {card.baseline ? (
        <div className="mt-4">
          <Block title={t("acc_baseline")} testId="acc-baseline">
            <p className={`mb-1.5 break-words text-xs ${card.baseline.verdict === "already_built" ? WARN : "text-muted-foreground"}`} data-testid="acc-baseline-summary" data-verdict={card.baseline.verdict}>
              {card.baseline.verdict === "already_built" ? (card.baseline.action === "stopped" ? t("acc_baseline_stopped") : t("acc_baseline_built")) : card.baseline.summary}
            </p>
            <ul className="space-y-1">
              {card.baseline.checks.map((row, index) => (
                <li key={`${row.command}:${index}`} className="flex min-w-0 items-start gap-1.5 text-sm" data-status={row.status}>
                  <Mark tone={row.status === "green" ? "ok" : row.status === "red" ? "bad" : "none"} label={row.status}>{row.status === "green" ? "✓" : row.status === "red" ? "✗" : "–"}</Mark>
                  <span className="min-w-0 break-words"><span className="break-all font-mono text-xs">{row.command}</span> <span className="text-xs text-muted-foreground">· {t(`acc_baseline_${row.status}` as I18nKey)}{row.cached ? ` · ${t("acc_baseline_cached")}` : ""}{row.status === "skipped" && row.note ? ` · ${row.note}` : ""}</span></span>
                </li>
              ))}
            </ul>
            {card.baseline.turnedRed === null ? null : (
              <p className={`mt-1.5 break-words text-xs ${card.baseline.turnedRed.length ? BAD : "text-muted-foreground"}`} data-testid="acc-baseline-turned">
                {card.baseline.turnedRed.length ? fill("acc_baseline_turned", { list: card.baseline.turnedRed.join(", ") }) : t("acc_baseline_nothing_turned")}
              </p>
            )}
          </Block>
        </div>
      ) : null}

      <div className="mt-4">
        <Block title={t("acc_notrun")} testId="acc-notrun">
          {card.notRun.length ? (
            <>
              <p className="mb-1.5 text-xs text-muted-foreground">{t("acc_notrun_note")}</p>
              <ul className="space-y-1">
                {card.notRun.map((row, index) => (
                  <li key={`${row.stageId}:${index}`} className="text-sm">
                    <span className={`font-medium ${WARN}`}>{stageName(row.stageId)}</span>
                    <span className="break-words text-xs text-muted-foreground"> · {row.why}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="text-xs text-muted-foreground">{t("acc_notrun_none")}</p>}
        </Block>
      </div>
    </section>
  );
}
