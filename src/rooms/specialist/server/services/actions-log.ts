import type { ActionsLogOutput, AutonomousAction } from "../../../contracts";
import type { LanePilotDatabase } from "../../../storage";
import { isAllowedUndoMethod } from "../../models/actions-log";

export interface ActionsLogInput {
  projectId?: string;
  since?: number;
  /** Only rows strictly older than this: the console's «Ещё» passes the oldest row it shows. */
  before?: number;
  limit?: number;
}

export interface ActionsLogDeps {
  autonomousEffects?: (
    db: LanePilotDatabase,
    since?: number,
    limit?: number,
    projectId?: string,
    before?: number,
  ) => AutonomousAction[];
  leadDecisions?: (
    db: LanePilotDatabase,
    since?: number,
    limit?: number,
    projectId?: string,
    before?: number,
  ) => AutonomousAction[];
  log?: { warn?: (message: string) => void; debug?: (message: string) => void };
}

interface SpMutationRow {
  mutation_id: string;
  project_id: string;
  domain: string;
  entity_id: string;
  mutation_kind: string;
  tier: string;
  delta_ratio: number | null;
  nonce_id: string | null;
  status: "applied" | "simulated" | "blocked" | "failed";
  detail_json: string;
  applied_at: number;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function wasBoundedAuto(db: LanePilotDatabase, row: SpMutationRow, detail: Record<string, unknown>): boolean {
  const explicitLevel =
    asNonEmptyString(detail.autonomy_class) ??
    asNonEmptyString(detail.autonomyClass) ??
    asNonEmptyString(detail.grant_level) ??
    asNonEmptyString(detail.grantLevel) ??
    asNonEmptyString(detail.authority);
  if (explicitLevel !== null) {
    return explicitLevel === "bounded_auto";
  }

  const actionClass = asNonEmptyString(detail.action_class) ?? asNonEmptyString(detail.actionClass) ?? row.mutation_kind;
  const grant = db
    .prepare(
      `SELECT 1 FROM lane_pilot_sp_autonomy_grant
       WHERE project_id = ? AND domain = ? AND action_class IN (?, ?)
         AND granted_at <= ? AND (revoked_at IS NULL OR revoked_at > ?)
       LIMIT 1`,
    )
    .get(row.project_id, row.domain, actionClass, row.mutation_kind, row.applied_at, row.applied_at);
  if (grant) return true;

  const autonomy = db
    .prepare(
      `SELECT 1 FROM lane_pilot_sp_autonomy
       WHERE project_id = ? AND domain = ? AND action_class IN (?, ?)
         AND autonomy_class = 'bounded_auto' AND high_risk = 0
         AND (frozen_until IS NULL OR frozen_until <= ?)
       LIMIT 1`,
    )
    .get(row.project_id, row.domain, actionClass, row.mutation_kind, row.applied_at);
  return Boolean(autonomy);
}

function resolveMutationUndo(detail: Record<string, unknown>): AutonomousAction["undo"] {
  const candidate =
    detail.revert && typeof detail.revert === "object" && !Array.isArray(detail.revert)
      ? (detail.revert as Record<string, unknown>)
      : detail.undo && typeof detail.undo === "object" && !Array.isArray(detail.undo)
        ? (detail.undo as Record<string, unknown>)
        : null;
  const method = asNonEmptyString(candidate?.method) ?? asNonEmptyString(detail.revertMethod);
  if (!method || !isAllowedUndoMethod(method)) return null;

  const rawInput =
    candidate?.input && typeof candidate.input === "object" && !Array.isArray(candidate.input)
      ? (candidate.input as Record<string, unknown>)
      : detail.revertInput && typeof detail.revertInput === "object" && !Array.isArray(detail.revertInput)
        ? (detail.revertInput as Record<string, unknown>)
        : null;
  return rawInput ? { method, input: rawInput } : null;
}

function readSpecialistMutations(
  db: LanePilotDatabase,
  since: number,
  limit: number,
  projectId?: string,
  before?: number,
): AutonomousAction[] {
  const where = ["status != 'simulated'", "applied_at >= ?"];
  const args: unknown[] = [since];
  if (before !== undefined) {
    where.push("applied_at < ?");
    args.push(before);
  }
  if (projectId) {
    where.push("project_id = ?");
    args.push(projectId);
  }
  const fetchLimit = Math.max(limit * 4, 200);
  const rows = db
    .prepare(
      `SELECT mutation_id, project_id, domain, entity_id, mutation_kind, tier, delta_ratio, nonce_id, status, detail_json, applied_at
       FROM lane_pilot_sp_mutation_log
       WHERE ${where.join(" AND ")}
       ORDER BY applied_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(...args, fetchLimit) as SpMutationRow[];

  const out: AutonomousAction[] = [];
  for (const row of rows) {
    const detail = parseJsonObject(row.detail_json);
    if (!wasBoundedAuto(db, row, detail)) continue;
    const summary = asNonEmptyString(detail.summary) ?? asNonEmptyString(detail.description);
    const action = summary ? `${row.mutation_kind} ${row.entity_id}: ${summary}` : `${row.mutation_kind} ${row.entity_id}`;
    const result: AutonomousAction["result"] =
      detail.reverted === true ? "reverted" : row.status === "applied" ? "done" : "failed";
    const evidenceRef =
      asNonEmptyString(detail.evidenceRef) ??
      asNonEmptyString(detail.evidence_ref) ??
      row.nonce_id ??
      row.mutation_id;
    out.push({
      id: `sp_mut:${row.mutation_id}`,
      at: row.applied_at,
      projectId: row.project_id,
      actor: `specialist:${row.domain}`,
      action,
      authority: "bounded_auto",
      result,
      evidenceRef,
      undo: resolveMutationUndo(detail),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function runPart<T>(
  name: string,
  fallback: T,
  log: ActionsLogDeps["log"],
  fn: () => T,
): T {
  try {
    return fn();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log?.warn?.(`[console] actions_log source=${name} failed: ${message}`);
    return fallback;
  }
}

/**
 * Merges autonomous specialist mutations (`bounded_auto`), workflow effects, and lead decisions newest first.
 * Each source is isolated so a failure in one room degrades only that source and logs a warning naming it.
 */
export function actionsLog(
  db: LanePilotDatabase,
  input: ActionsLogInput = {},
  deps: ActionsLogDeps = {},
): ActionsLogOutput {
  const since = typeof input.since === "number" && Number.isFinite(input.since) ? input.since : 0;
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const projectId = input.projectId;
  const before = typeof input.before === "number" && Number.isFinite(input.before) ? input.before : undefined;

  const mutations = runPart("specialist_mutations", [] as AutonomousAction[], deps.log, () =>
    readSpecialistMutations(db, since, limit, projectId, before),
  );
  const effects = runPart("workflow_effects", [] as AutonomousAction[], deps.log, () =>
    deps.autonomousEffects ? deps.autonomousEffects(db, since, limit, projectId, before) : [],
  );
  const decisions = runPart("lead_decisions", [] as AutonomousAction[], deps.log, () =>
    deps.leadDecisions ? deps.leadDecisions(db, since, limit, projectId, before) : [],
  );

  const merged = [...mutations, ...effects, ...decisions]
    .filter((row) => row.at >= since && (before === undefined || row.at < before) && (!projectId || row.projectId === projectId))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, limit);

  deps.log?.debug?.(`[console] actions_log project=${projectId ?? "all"} before=${before ?? "none"} rows=${merged.length}`);
  return { rows: merged };
}
