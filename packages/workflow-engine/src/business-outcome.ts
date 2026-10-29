/**
 * One reading of a workflow run's business outcome, shared by the library, the router, live proof and the scheduler.
 * The engine status `succeeded` only means the graph finished. `closed` is work done; `blocked` is a correct refusal;
 * `proposed` is an escalation; `partial` is unfinished. A chain's `live_success` list still decides what proves it.
 */

export const FAILED_FINAL_STATUSES: readonly string[] = ["aborted", "blocked", "failed", "failure", "error", "send_failed", "send_unconfirmed", "rolled_back"];

export type FinalRule = { output: string; in: readonly string[] } | null | undefined;

export type FinishKind = "done" | "refused" | "escalated" | "incomplete" | "failed";

export type WorkflowFinish = { ok: boolean; kind: FinishKind; status: string; detail: string };

/** The rule a run's pinned definition declares (`live_success`), or null when it has none or the text is not a definition. */
export function finalRuleOf(definitionJson: string | null | undefined): FinalRule {
  try {
    const rule = (JSON.parse(definitionJson ?? "null") as { live_success?: { output?: unknown; in?: unknown } } | null)?.live_success;
    if (rule && Array.isArray(rule.in) && rule.in.every((item) => typeof item === "string")) return { output: typeof rule.output === "string" ? rule.output : "status", in: rule.in as string[] };
  } catch { /* not a definition: no rule */ }
  return null;
}

/** Whether the final output of a succeeded workflow run is a finished job, a refusal, an escalation, unfinished, or a failure. */
export function workflowFinish(output: Record<string, unknown> | null | undefined, rule: FinalRule): WorkflowFinish {
  const field = rule?.output ?? "status";
  const raw = output?.[field];
  const status = typeof raw === "string" ? raw : "";
  const detailFor = (kind: FinishKind): WorkflowFinish => {
    const reason = typeof output?.reason === "string" && output.reason ? `: ${output.reason}` : "";
    return { ok: false, kind, status: status || "none", detail: `the chain ended with ${field} «${status || "none"}»${reason}`.slice(0, 500) };
  };
  if (rule?.in.includes(status)) return { ok: true, kind: "done", status, detail: "" };
  if (status === "proposed") return detailFor("escalated");
  if (status === "blocked") return detailFor("refused");
  if (status === "partial") return detailFor("incomplete");
  if (rule || FAILED_FINAL_STATUSES.includes(status)) return detailFor("failed");
  return { ok: true, kind: "done", status, detail: "" };
}

export type OutcomeRow = { status: string; output_json: string | null; definition_json: string | null };

export type OutcomeTally = {
  runs: number;
  active: number;
  /** Engine status succeeded: the graph executed. */
  executed: number;
  workDone: number;
  refused: number;
  escalated: number;
  /** Engine status failed, blocked, interrupted or not_verified. */
  engineBad: number;
};

const ENGINE_BAD = new Set(["failed", "blocked", "interrupted", "not_verified"]);

/** ponytail: every run's output is parsed in JS. Ceiling: a workflow with a very long history. Upgrade: store the kind when the run closes. */
export function tallyOutcomes(rows: readonly OutcomeRow[]): OutcomeTally {
  const tally: OutcomeTally = { runs: rows.length, active: 0, executed: 0, workDone: 0, refused: 0, escalated: 0, engineBad: 0 };
  for (const row of rows) {
    if (row.status === "running" || row.status === "waiting") { tally.active += 1; continue; }
    if (row.status !== "succeeded") { if (ENGINE_BAD.has(row.status)) tally.engineBad += 1; continue; }
    let output: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(row.output_json ?? "null") as unknown;
      output = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { output = null; }
    const finish = workflowFinish(output, finalRuleOf(row.definition_json));
    tally.executed += 1;
    if (finish.kind === "done") tally.workDone += 1;
    else if (finish.kind === "refused") tally.refused += 1;
    else if (finish.kind === "escalated") tally.escalated += 1;
  }
  return tally;
}

/** Work done over executed plus engine failures. A refusal, an escalation or an unfinished run does not raise it. Null before any of those exist. */
export function workDoneRate(tally: Pick<OutcomeTally, "executed" | "workDone" | "engineBad">): number | null {
  const settled = tally.executed + tally.engineBad;
  return settled > 0 ? tally.workDone / settled : null;
}
