import { goalsSchema, parseGoals } from "./goals";
import type { RunGoal } from "./goals";
import { kick } from "./engine-drive";
import type { WorkflowEngine } from "./engine";

/** Every state the goals of a run have been in, oldest first: what changed, why and who said so. */
export function goalJournal(engine: WorkflowEngine, runId: string): Array<{ seq: number; at: number; by: string; reason: string; goals: RunGoal[] }> {
  const rows = engine.journal.db.prepare("SELECT seq, at, detail FROM lane_pilot_wf_event WHERE run_id=? AND kind='goals' ORDER BY seq").all(runId) as Array<{ seq: number; at: number; detail: string | null }>;
  return rows.flatMap((row) => {
    try { const detail = JSON.parse(row.detail ?? "{}") as { goals?: unknown; reason?: unknown; by?: unknown }; return [{ seq: row.seq, at: row.at, by: String(detail.by ?? ""), reason: String(detail.reason ?? ""), goals: parseGoals(JSON.stringify(detail.goals ?? [])) }]; } catch { return []; }
  });
}

/**
 * K7: the owner or the PM changes what the run is for. The whole list is replaced; the reason and the author go into the journal with the
 * list that was replaced. A run that was blocked by its goal audit is audited again against the new goals.
 */
export function amendGoals(engine: WorkflowEngine, runId: string, goals: unknown, reason: string, by = "pm"): { ok: true; version: number; reopened: boolean } | { ok: false; reason: string } {
  const j = engine.journal;
  const run = j.getRun(runId);
  if (!run) return { ok: false, reason: "not_found" };
  if (run.status === "canceled") return { ok: false, reason: "run_canceled" };
  const parsed = goalsSchema.safeParse(goals);
  if (!parsed.success) return { ok: false, reason: `invalid_goals: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "goals"} ${issue.message}`).join("; ")}` };
  const why = reason.trim();
  if (why.length < 3) return { ok: false, reason: "reason_required" };
  const before = parseGoals(run.goals_json);
  const reopen = run.status === "blocked" && (run.reason ?? "").startsWith("goal_audit");
  j.db.transaction(() => {
    j.db.prepare("UPDATE lane_pilot_wf_run SET goals_json=?, updated_at=? WHERE id=?").run(parsed.data.length ? JSON.stringify(parsed.data) : null, engine.now(), runId);
    j.event(runId, null, "goals", null, null, JSON.stringify({ goals: parsed.data, before, reason: why.slice(0, 600), by }));
    if (reopen) j.setRunStatus(runId, ["blocked"], "running", null);
  })();
  if (reopen) void kick(engine, runId).catch((cause) => engine.log(`run ${runId} stopped after its goals were amended: ${cause instanceof Error ? cause.message : String(cause)}`));
  return { ok: true, version: goalJournal(engine, runId).length, reopened: reopen };
}
