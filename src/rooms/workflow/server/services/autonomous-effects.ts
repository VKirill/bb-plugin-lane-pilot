import { listAutonomousWfEffects, type AutonomousWfEffectRow } from "@lane-pilot/workflow-engine";
import type { AutonomousAction } from "../../../contracts";
import type { LanePilotDatabase } from "../../../storage";
import { isInternalUpkeep } from "../../models/internal-workflows";

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

function formatEffectAction(row: AutonomousWfEffectRow, intent: Record<string, unknown> | null, result: Record<string, unknown> | null): string {
  const detail =
    asNonEmptyString(result?.name) ??
    asNonEmptyString(result?.title) ??
    asNonEmptyString(intent?.name) ??
    asNonEmptyString(intent?.title) ??
    asNonEmptyString(intent?.scheduleName);
  return detail ? `${row.kind}:${row.effect_key} (${detail})` : `${row.kind}:${row.effect_key}`;
}

function resolveEffectUndo(
  row: AutonomousWfEffectRow,
  result: Record<string, unknown> | null,
): AutonomousAction["undo"] {
  if (row.state !== "done" || !result) return null;
  if (row.kind === "schedule") {
    const nested = result.schedule && typeof result.schedule === "object" && !Array.isArray(result.schedule)
      ? (result.schedule as Record<string, unknown>)
      : null;
    const scheduleId = asNonEmptyString(result.scheduleId) ?? asNonEmptyString(nested?.id) ?? asNonEmptyString(result.id);
    if (scheduleId) return { method: "schedule_pause", input: { id: scheduleId } };
  }
  if (row.kind === "workflow_draft" || row.kind === "evolve_publish") {
    const draftId = asNonEmptyString(result.draftId);
    if (draftId) return { method: "workflow_draft_rollback", input: { draftId } };
  }
  return null;
}

/** Reads settled workflow effects from the workflow journal and projects them into the console actions feed. */
export function autonomousEffects(
  db: LanePilotDatabase,
  since = 0,
  limit = 50,
  projectId?: string,
  before?: number,
): AutonomousAction[] {
  const rows = listAutonomousWfEffects(db as never, since, limit, projectId, before);
  return rows.map((row) => {
    const intent = parseJsonObject(row.intent_json);
    const resultObj = parseJsonObject(row.result_json);
    const authority: AutonomousAction["authority"] =
      isInternalUpkeep(row.workflow_id) || row.workflow_id.startsWith("lp.") ? "maintenance" : "repo_rule";
    const result: AutonomousAction["result"] =
      row.state === "done" ? (resultObj?.reverted === true ? "reverted" : "done") : "failed";
    return {
      id: `wf_eff:${row.id}`,
      at: row.updated_at,
      projectId: row.project_id ?? null,
      actor: `workflow:${row.workflow_id}`,
      action: formatEffectAction(row, intent, resultObj),
      authority,
      result,
      evidenceRef: row.link_task_id ?? row.run_id,
      undo: resolveEffectUndo(row, resultObj),
    };
  });
}
