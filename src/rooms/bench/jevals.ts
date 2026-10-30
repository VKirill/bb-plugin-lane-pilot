import type { Jev } from "@lane-pilot/jev";
import { traceChecks, TRACE_CHECKS, type TraceCheck, type TraceDecision } from "@lane-pilot/jev/judgments/trace-checks";
import type { AttemptMetrics } from "../usage/server";
import type { ManifestTask } from "./types";

/**
 * The jevals evals of one bench task's attempt traces (audit top-10): the six-plus-one checks of `audit.trace` in a single
 * request, recorded into the result's metrics_json as the arm's trace quality, and into the audit report the bench prints.
 * An `indirect_injection` flag also marks the receipt itself (`outcome` `warn:indirect_injection`): the trace may have
 * carried hostile content, so its other labels are trusted less.
 */
export type JevalsResult = { checks: Record<TraceCheck, number>; flags: TraceCheck[]; receiptId: number | null; by: "jev" | "off" };

/** The attempt metrics rendered as the trace text the checks read. */
export function traceText(task: ManifestTask, outcome: { latestState: string | null }, attempts: readonly AttemptMetrics[], reason: string | null): string {
  const lines = [`task ${task.taskId} (${task.stratum}, risk ${task.risk}): ${String(task.contract.title ?? "")}`, `ended: ${outcome.latestState ?? "no attempt"}${reason ? ` — ${reason}` : ""}`];
  for (const attempt of attempts) {
    lines.push(`attempt #${attempt.attemptNo} (${attempt.attemptId}): ${attempt.state}, ${attempt.seconds ?? "?"}s, gates ${attempt.gates.passed} passed / ${attempt.gates.rejected} rejected, tokens ${attempt.tokens?.total ?? "unmeasured"}`);
    for (const stage of attempt.stages) lines.push(`  stage ${stage.stageId}: ${stage.state}${stage.seconds === null ? "" : ` ${stage.seconds}s`} (${stage.proof})`);
  }
  return lines.join("\n");
}

/** One judge call per task (shadow until the project raises it): a result entry for metrics_json, never a blocker. */
export async function judgeTrace(deps: { jev(): Jev | null; settings?: Record<string, unknown>; projectId?: string | null; runId?: string | null; now?: () => number },
  input: { task: ManifestTask; outcome: { latestState: string | null }; attempts: readonly AttemptMetrics[]; reason: string | null }): Promise<JevalsResult | null> {
  const jev = deps.jev();
  if (!jev || !jev.enabled(deps.settings)) return null;
  const verdict = await jev.judge(traceChecks, { task: { title: String(input.task.contract.title ?? input.task.taskId), objective: String(input.task.contract.objective ?? ""), acceptance: Array.isArray(input.task.contract.acceptance) ? input.task.contract.acceptance.map(String) : [] },
    trace: traceText(input.task, input.outcome, input.attempts, input.reason) },
    { projectId: deps.projectId ?? null, runId: deps.runId ?? null, subject: `bench:${input.task.taskId}`, settings: deps.settings }).catch(() => null);
  if (!verdict) return null;
  const decision: TraceDecision = verdict.by === "jev" ? verdict.decision : (verdict.by === "fallback" ? verdict.shadow?.decision : undefined) ?? traceChecks.fallback({ task: { title: "" }, trace: "" });
  if (decision.flags.includes("indirect_injection")) jev.outcome(verdict.receiptId, "warn:indirect_injection");
  return { checks: decision.checks, flags: decision.flags, receiptId: verdict.receiptId, by: verdict.by === "jev" ? "jev" : "off" };
}

/** The audit-report lines of one task's evals, for the series log. */
export function jevalsLine(result: JevalsResult | null): string | null {
  if (!result) return null;
  const weak = TRACE_CHECKS.filter((name) => (result.checks[name] ?? 0) < 0.5).map((name) => `${name} ${result.checks[name]}`);
  return `jevals: ${result.flags.length ? `flags ${result.flags.join(",")}` : "clean"}${weak.length ? ` (${weak.join("; ")})` : ""}`;
}
