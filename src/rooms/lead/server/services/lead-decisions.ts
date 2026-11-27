import type { AutonomousAction } from "../../../contracts";
import type { LanePilotDatabase } from "../../../storage";

interface LeadDecisionRow {
  id: string;
  project_id: string | null;
  run_id: string | null;
  surface: string;
  class: string;
  answer_json: string | null;
  answered_at: number;
  answered_by: string;
  judge_verdict: string | null;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Reads autonomous lead decisions (not answered by the human owner) newest first for the console actions feed. */
export function leadDecisions(
  db: LanePilotDatabase,
  since = 0,
  limit = 50,
  projectId?: string,
): AutonomousAction[] {
  const cap = Math.max(1, Math.min(200, Math.floor(limit || 50)));
  const where = [
    "answered_at IS NOT NULL",
    "answered_at >= ?",
    "COALESCE(TRIM(answered_by), '') != ''",
    "LOWER(TRIM(answered_by)) NOT IN ('owner', 'human')",
    "split != 'backtest'",
  ];
  const args: unknown[] = [since];
  if (projectId) {
    where.push("project_id = ?");
    args.push(projectId);
  }
  const rows = db.prepare(
    `SELECT id, project_id, run_id, surface, class, answer_json, answered_at, answered_by, judge_verdict
     FROM lane_pilot_decision
     WHERE ${where.join(" AND ")}
     ORDER BY answered_at DESC, rowid DESC
     LIMIT ?`,
  ).all(...args, cap) as LeadDecisionRow[];

  return rows.map((row) => {
    const answer = parseJsonObject(row.answer_json);
    const choice = asNonEmptyString(answer?.choice) ?? asNonEmptyString(answer?.decision) ?? asNonEmptyString(answer?.label);
    const actorRaw = row.answered_by.trim();
    const actor = actorRaw === "lead" || actorRaw.startsWith("lead:") ? actorRaw : `lead:${actorRaw}`;
    const result: AutonomousAction["result"] =
      answer?.reverted === true ? "reverted" : row.judge_verdict === "miss" ? "failed" : "done";
    return {
      id: `lead_dec:${row.id}`,
      at: row.answered_at,
      projectId: row.project_id ?? null,
      actor,
      action: choice ? `${row.surface}:${row.class} -> ${choice}` : `${row.surface}:${row.class}`,
      authority: "bounded_auto",
      result,
      evidenceRef: row.run_id ?? row.id,
      undo: null,
    };
  });
}
