import { sha256 } from "./journal";
import type { RunRow } from "./journal";
import { goalsSha, parseGoals, tinyGoalByCode } from "./goals";
import type { GoalAudit } from "./goals";
import { asObject } from "./step-read";
import { isEngineBug } from "./engine-errors";
import type { WorkflowEngine } from "./engine";

/** Size from the `class` step, and whether a writer was accepted or the plan already met the goal. */
export function shortPathFacts(engine: WorkflowEngine, run: RunRow): { size: unknown; accepted: boolean; acceptance: unknown; alreadyMet: boolean } {
  let size: unknown = asObject(run.inputs_json).size;
  let accepted = false;
  let acceptance: unknown;
  let alreadyMet = false;
  for (const step of engine.journal.steps(run.id)) {
    if (step.state !== "succeeded" || !step.output_json) continue;
    let body: Record<string, unknown>;
    try { body = asObject(step.output_json); } catch { continue; }
    if (step.node_id === "class" && typeof body.size === "string") size = body.size;
    if (body.state === "accepted") accepted = true;
    if (body.already_met === true && body.task_count === 0) alreadyMet = true;
    const tasks = body.tasks;
    if (!Array.isArray(tasks)) continue;
    const first = tasks.find((item) => item !== null && typeof item === "object");
    const named = first && typeof first === "object" ? (first as { acceptance?: unknown }).acceptance : undefined;
    if (Array.isArray(named)) acceptance = named;
  }
  return { size, accepted, acceptance, alreadyMet };
}

/**
 * K7: a run that has goals is judged against them before it closes. All met: it closes. Some not: it is `blocked` with the
 * unmet goal ids as the reason, the verdict is in the journal, and the PM either fixes the work (re-run a node: the run reaches
 * its exit and is audited again) or amends the goals with a reason (which audits again). A user workflow (`goal_audit: required`)
 * with no goals, and any run whose audit could not be made, closes `not_verified`: that is not a verified success. A service
 * graph with no goals closes without calling the auditor.
 */
export async function closeAfterAudit(engine: WorkflowEngine, run: RunRow): Promise<"closed" | "blocked" | "stop"> {
  const j = engine.journal;
  const close = (reason: string | null) => { j.setRunStatus(run.id, ["running", "waiting"], "succeeded", reason); return "closed" as const; };
  const unverified = (reason: string, detail: Record<string, unknown>) => {
    j.event(run.id, null, "goal_audit", null, "not_verified", JSON.stringify({ verdict: "not_verified", ...detail }));
    j.setRunStatus(run.id, ["running", "waiting"], "not_verified", reason);
    return "closed" as const;
  };
  // A child run carries the goals so its helpers are reminded of them; it is the parent run, which owns the whole outcome, that is audited.
  const goals = parseGoals(run.goals_json), audit = engine.options.auditGoals;
  if (run.parent_run_id) return close(null);
  let required = false;
  try { required = (JSON.parse(run.definition_json) as { goal_audit?: string }).goal_audit === "required"; } catch { required = false; }
  if (!goals.length) return required ? unverified("not_verified: a user workflow closed with no goals", { error: "no goals" }) : close(null);
  const output = asObject(run.output_json);
  const code = tinyGoalByCode({ ...shortPathFacts(engine, run), status: output.status });
  if (code !== "skip") {
    const sha = goalsSha(goals);
    const outputSha = sha256(run.output_json ?? "");
    if (code === "met") {
      j.event(run.id, null, "goal_audit", null, "pass", JSON.stringify({ sha, outputSha, verdict: "pass", by: "code", met: goals.map((goal) => goal.id), unmet: [] }));
      return close(null);
    }
    const unmet = goals.map((goal) => ({ id: goal.id, why: "a tiny run closes only when the checks are green and the task names its acceptance" }));
    j.event(run.id, null, "goal_audit", null, "gaps", JSON.stringify({ sha, outputSha, verdict: "gaps", by: "code", met: [], unmet }));
    j.setRunStatus(run.id, ["running", "waiting"], "blocked", `goal_audit: not met: ${unmet.map((entry) => entry.id).join(", ")}`);
    return "blocked";
  }
  if (!audit) return close(null);
  const sha = goalsSha(goals);
  // A pass is a verdict on this output: a re-run node that changed the result is audited again (2026-10-29 audit A-001).
  const outputSha = sha256(run.output_json ?? "");
  const last = lastAudit(engine, run.id);
  if (last?.sha === sha && last.outputSha === outputSha && last.verdict === "pass") return close(null);
  const abort = engine.aborts.get(run.id) ?? new AbortController();
  engine.aborts.set(run.id, abort);
  let result: GoalAudit;
  try { result = await audit({ run, goals, output, steps: j.steps(run.id), signal: abort.signal }); }
  catch (cause) {
    if (isEngineBug(cause)) throw cause;
    if (engine.stopped()) return "stop";
    const message = cause instanceof Error ? cause.message : String(cause);
    return unverified(`not_verified: goal_audit_unavailable: ${message.slice(0, 260)}`, { sha, outputSha, error: message.slice(0, 500) });
  }
  const unmet = result.unmet.filter((entry) => goals.some((goal) => goal.id === entry.id));
  // A goal the auditor did not mention at all is not met: silence is not evidence.
  for (const goal of goals) if (!result.met.includes(goal.id) && !unmet.some((entry) => entry.id === goal.id)) unmet.push({ id: goal.id, why: "the audit gave no verdict on this goal" });
  const verdict = unmet.length ? "gaps" : "pass";
  j.event(run.id, null, "goal_audit", null, verdict, JSON.stringify({ sha, outputSha, verdict, met: result.met.filter((id) => goals.some((goal) => goal.id === id) && !unmet.some((entry) => entry.id === id)), unmet, ...(result.notes ? { notes: result.notes.slice(0, 1000) } : {}) }));
  if (!unmet.length) return close(null);
  j.setRunStatus(run.id, ["running", "waiting"], "blocked", `goal_audit: not met: ${unmet.map((entry) => entry.id).join(", ")}`);
  return "blocked";
}

/** The last goal audit of a run, as the journal has it. */
export function lastAudit(engine: WorkflowEngine, runId: string): { sha: string; outputSha?: string; verdict: "pass" | "gaps" | "unavailable" | "not_verified"; met: string[]; unmet: Array<{ id: string; why: string }>; notes?: string; error?: string; at: number } | null {
  const row = engine.journal.db.prepare("SELECT detail, at FROM lane_pilot_wf_event WHERE run_id=? AND kind='goal_audit' ORDER BY seq DESC LIMIT 1").get(runId) as { detail: string | null; at: number } | undefined;
  if (!row?.detail) return null;
  try { const detail = JSON.parse(row.detail) as Record<string, unknown>; return { sha: String(detail.sha ?? ""), ...(typeof detail.outputSha === "string" ? { outputSha: detail.outputSha } : {}), verdict: detail.verdict as "pass", met: (detail.met as string[] | undefined) ?? [], unmet: (detail.unmet as Array<{ id: string; why: string }> | undefined) ?? [], ...(typeof detail.notes === "string" ? { notes: detail.notes } : {}), ...(typeof detail.error === "string" ? { error: detail.error } : {}), at: row.at }; } catch { return null; }
}
