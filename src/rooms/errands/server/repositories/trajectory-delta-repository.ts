import { redactKnown, sha256Hex } from "@lane-pilot/kit";
import { maskPii, scrubQuote } from "../../../memory";
import { pmSkillName } from "../../../native-agent";
import { hasExplicitSkillIntent, resolveSkillIntent } from "../../models/skill-intent";
import {
  TRAJECTORY_DELTA_SUMMARY_CLIP,
  emitTrajectoryLog,
  isValidInterventionKind,
  normalizeStage,
  toTrajectoryDeltaRow,
  type RecordTrajectoryDeltaInput,
  type RecordTrajectoryDeltaResult,
  type TrajectoryDeltaRow,
} from "../../models/trajectory-delta";

type DbStmt = { run(...params: unknown[]): { changes: number }; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
type DbLike = { prepare(sql: string): DbStmt };

/** Records one masked owner trajectory delta idempotently into `lane_pilot_trajectory_delta`. */
export function recordTrajectoryDelta(db: DbLike, input: RecordTrajectoryDeltaInput): RecordTrajectoryDeltaResult {
  const warnSink = input.warn ?? input.log;
  if (!isValidInterventionKind(input.interventionKind)) {
    emitTrajectoryLog(warnSink, "warn", "rejected", { reason: "invalid_kind", kind: String(input.interventionKind) }, input.logLevel);
    return { status: "rejected", row: null, reason: "invalid_kind" };
  }
  const trimmed = (input.rawSummary ?? "").trim();
  if (!trimmed) {
    emitTrajectoryLog(warnSink, "warn", "rejected", { reason: "empty_summary", kind: input.interventionKind }, input.logLevel);
    return { status: "rejected", row: null, reason: "empty_summary" };
  }

  let maskedSummary: string;
  try {
    maskedSummary = maskPii(scrubQuote(redactKnown(trimmed), TRAJECTORY_DELTA_SUMMARY_CLIP)).text.trim();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    emitTrajectoryLog(warnSink, "error", "mask_failed", { kind: input.interventionKind, error: message.slice(0, 160) }, input.logLevel);
    return { status: "rejected", row: null, reason: "mask_failed" };
  }
  if (!maskedSummary) {
    emitTrajectoryLog(warnSink, "warn", "rejected", { reason: "empty_after_mask", kind: input.interventionKind }, input.logLevel);
    return { status: "rejected", row: null, reason: "empty_after_mask" };
  }

  const skillSet = new Set<string>();
  for (const s of input.resolvedSkills ?? []) {
    const norm = pmSkillName(s).toLowerCase();
    if (norm) skillSet.add(norm);
  }
  if (input.catalog?.length && (input.interventionKind === "skill_request" || hasExplicitSkillIntent(trimmed))) {
    for (const match of resolveSkillIntent(trimmed, input.catalog, { log: input.log, logLevel: input.logLevel })) {
      skillSet.add(match.name);
    }
  }
  const resolvedSkills = [...skillSet].slice(0, 12);
  const stageArchetype = normalizeStage(input.stageArchetype);
  const ownerAccepted = input.ownerAccepted !== false;
  const createdAt = input.now ?? Date.now();
  const id = input.id?.trim() || `tdelta_${sha256Hex(`${input.projectId ?? ""}|${input.threadId ?? ""}|${input.workflowId ?? ""}|${stageArchetype}|${input.interventionKind}|${maskedSummary}`).slice(0, 24)}`;

  const res = db.prepare(
    `INSERT OR IGNORE INTO lane_pilot_trajectory_delta
      (id, project_id, thread_id, workflow_id, stage_archetype, intervention_kind, resolved_skills_json, masked_summary, owner_accepted, processed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    input.projectId ?? null,
    input.threadId ?? null,
    input.workflowId ?? null,
    stageArchetype,
    input.interventionKind,
    JSON.stringify(resolvedSkills),
    maskedSummary,
    ownerAccepted ? 1 : 0,
    createdAt,
  );

  const stored = db.prepare(`SELECT * FROM lane_pilot_trajectory_delta WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  const row = stored ? toTrajectoryDeltaRow(stored) : null;
  if (res.changes === 0) {
    emitTrajectoryLog(input.log, "debug", "duplicate", { id, kind: input.interventionKind, stageArchetype }, input.logLevel);
    return { status: "duplicate", row };
  }
  emitTrajectoryLog(input.log, "info", "recorded", { id, kind: input.interventionKind, stageArchetype, skillsCount: resolvedSkills.length }, input.logLevel);
  return { status: "recorded", row };
}

/** Lists unprocessed trajectory deltas in chronological order for nightly graph crystallization/evolution. */
export function listUnprocessedTrajectoryDeltas(
  db: DbLike,
  options?: { readonly limit?: number; readonly projectId?: string; readonly onlyAccepted?: boolean },
): TrajectoryDeltaRow[] {
  const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
  const onlyAccepted = options?.onlyAccepted !== false;
  if (options?.projectId) {
    const rows = db.prepare(
      `SELECT * FROM lane_pilot_trajectory_delta
       WHERE processed_at IS NULL AND project_id = ? AND (? = 0 OR owner_accepted = 1)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).all(options.projectId, onlyAccepted ? 1 : 0, limit) as Array<Record<string, unknown>>;
    return rows.map(toTrajectoryDeltaRow);
  }
  const rows = db.prepare(
    `SELECT * FROM lane_pilot_trajectory_delta
     WHERE processed_at IS NULL AND (? = 0 OR owner_accepted = 1)
     ORDER BY created_at ASC, id ASC LIMIT ?`,
  ).all(onlyAccepted ? 1 : 0, limit) as Array<Record<string, unknown>>;
  return rows.map(toTrajectoryDeltaRow);
}

/** Marks processed trajectory deltas with `processed_at` once a nightly pass has consumed them. */
export function markTrajectoryDeltasProcessed(
  db: DbLike,
  ids: readonly string[],
  processedAt = Date.now(),
  log?: (message: string) => void,
): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare(`UPDATE lane_pilot_trajectory_delta SET processed_at = ? WHERE id = ? AND processed_at IS NULL`);
  let updated = 0;
  for (const id of ids) {
    if (!id) continue;
    updated += stmt.run(processedAt, id).changes;
  }
  if (updated > 0) emitTrajectoryLog(log, "info", "processed", { count: updated, processedAt });
  return updated;
}
