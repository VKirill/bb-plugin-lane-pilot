import type { RunRow, ScheduleRow } from "./store";

/**
 * A workflow run ends `succeeded` also on the branches that did not do the job (the owner said no, Elba showed a login wall, the
 * send failed): audit 2026-10-08 round 4, item 16. The schedule counts those as failed. A chain that says which final statuses prove
 * it (`live_success`) is judged by that; any other chain by this list of statuses that never mean «done».
 */
export const FAILED_FINAL_STATUSES: readonly string[] = ["aborted", "blocked", "failed", "failure", "error", "send_failed", "send_unconfirmed", "rolled_back"];

export type FinalRule = { output: string; in: readonly string[] } | null | undefined;

/** The rule a run's pinned definition declares (`live_success`), or null when it has none or the text is not a definition. */
export function finalRuleOf(definitionJson: string | null | undefined): FinalRule {
  try {
    const rule = (JSON.parse(definitionJson ?? "null") as { live_success?: { output?: unknown; in?: unknown } } | null)?.live_success;
    if (rule && Array.isArray(rule.in) && rule.in.every((item) => typeof item === "string")) return { output: typeof rule.output === "string" ? rule.output : "status", in: rule.in as string[] };
  } catch { /* not a definition: no rule */ }
  return null;
}

/** Whether the final output of a succeeded workflow run is a finished job; when it is not, why (one line). */
export function workflowFinish(output: Record<string, unknown> | null | undefined, rule: FinalRule): { ok: true } | { ok: false; status: string; detail: string } {
  const field = rule?.output ?? "status";
  const raw = output?.[field];
  const status = typeof raw === "string" ? raw : "";
  const bad = rule ? !rule.in.includes(status) : FAILED_FINAL_STATUSES.includes(status);
  if (!bad) return { ok: true };
  const reason = typeof output?.reason === "string" && output.reason ? `: ${output.reason}` : "";
  return { ok: false, status: status || "none", detail: `the chain ended with ${field} «${status || "none"}»${reason}`.slice(0, 500) };
}

/** The one message to the PM chat after a failed scheduled run; it says the schedule is paused when this failure paused it. */
export function scheduleFailureNotice(schedule: Pick<ScheduleRow, "name" | "consecutive_failures">, run: Pick<RunRow, "status" | "error" | "reason">, paused: boolean): string {
  const what = `Lane Pilot schedule «${schedule.name}» ${run.status === "timed_out" ? "timed out" : "failed"}: ${(run.error ?? run.reason ?? "no detail").slice(0, 300)}`;
  const times = schedule.consecutive_failures;
  return paused
    ? `${what}\nIt failed ${times} times in a row and is paused. Open the schedule board to look at the history and resume it.`
    : `${what}\nIt failed ${times} time${times === 1 ? "" : "s"} in a row; it keeps running until it has failed too often in a row, then the schedule pauses itself. The history is on the schedule board.`;
}
