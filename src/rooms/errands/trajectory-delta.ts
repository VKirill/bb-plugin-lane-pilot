import { redactKnown, sha256Hex } from "@lane-pilot/kit";
import { maskPii, scrubQuote } from "../anamnesis";
import { pmSkillName } from "../native-agent";
import {
  hasExplicitSkillIntent,
  resolveSkillIntent,
  shouldEmitSkillLog,
  type SkillCatalogItem,
  type SkillIntentLogLevel,
} from "./skill-intent";

/**
 * Append-only ledger of standardized owner trajectory maneuvers in chats and runs
 * (skill requests, rule additions, step insertions, reference branch picks, variant choices).
 * Every text field is masked through redactKnown -> scrubQuote -> maskPii before touching SQLite.
 */
export const TRAJECTORY_DELTA_TABLE = "lane_pilot_trajectory_delta";

export const TRAJECTORY_INTERVENTION_KINDS = [
  "skill_request",
  "rule_added",
  "step_inserted",
  "reference_branch",
  "variant_selected",
  "over_constraint",
] as const;

export type TrajectoryInterventionKind = (typeof TRAJECTORY_INTERVENTION_KINDS)[number];

export const trajectoryDeltaMigrations = [
  `CREATE TABLE lane_pilot_trajectory_delta (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    thread_id TEXT,
    workflow_id TEXT,
    stage_archetype TEXT NOT NULL,
    intervention_kind TEXT NOT NULL CHECK(intervention_kind IN ('skill_request','rule_added','step_inserted','reference_branch','variant_selected')),
    resolved_skills_json TEXT NOT NULL DEFAULT '[]',
    masked_summary TEXT NOT NULL,
    owner_accepted INTEGER NOT NULL DEFAULT 1 CHECK(owner_accepted IN (0, 1)),
    processed_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_trajectory_delta_unprocessed ON lane_pilot_trajectory_delta(processed_at, created_at)`,
  `CREATE INDEX lane_pilot_trajectory_delta_project ON lane_pilot_trajectory_delta(project_id, created_at)`,
  `CREATE TRIGGER lane_pilot_trajectory_delta_no_delete BEFORE DELETE ON lane_pilot_trajectory_delta BEGIN SELECT RAISE(ABORT, 'trajectory deltas are append-only'); END`,
] as const;

export type TrajectoryDeltaRow = {
  readonly id: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly workflowId: string | null;
  readonly stageArchetype: string;
  readonly interventionKind: TrajectoryInterventionKind;
  readonly resolvedSkills: string[];
  readonly maskedSummary: string;
  readonly ownerAccepted: boolean;
  readonly processedAt: number | null;
  readonly createdAt: number;
};

export type RecordTrajectoryDeltaInput = {
  readonly id?: string;
  readonly projectId?: string | null;
  readonly threadId?: string | null;
  readonly workflowId?: string | null;
  readonly stageArchetype?: string;
  readonly interventionKind: TrajectoryInterventionKind;
  readonly rawSummary: string;
  readonly resolvedSkills?: readonly string[];
  readonly catalog?: readonly SkillCatalogItem[];
  readonly ownerAccepted?: boolean;
  readonly now?: number;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
  readonly logLevel?: SkillIntentLogLevel;
};

export type RecordTrajectoryDeltaResult = {
  readonly status: "recorded" | "duplicate" | "rejected";
  readonly row: TrajectoryDeltaRow | null;
  readonly reason?: string;
};

type DbStmt = { run(...params: unknown[]): { changes: number }; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
type DbLike = { prepare(sql: string): DbStmt };

const KIND_SET = new Set<string>(TRAJECTORY_INTERVENTION_KINDS);
const SUMMARY_CLIP = 600;

function emit(
  sink: ((message: string) => void) | undefined,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  payload: Record<string, unknown>,
  override?: SkillIntentLogLevel,
): void {
  if (!sink || !shouldEmitSkillLog(level, override, true)) return;
  sink(redactKnown(`${level.toUpperCase()} [errands.trajectoryDelta] ${event} ${JSON.stringify(payload)}`));
}

const normalizeStage = (raw: string | undefined): string => {
  const slug = (raw ?? "general").trim().toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (slug || "general").slice(0, 64);
};

const parseSkills = (json: string | null | undefined): string[] => {
  try {
    const parsed = json ? (JSON.parse(json) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map((s) => String(s)).filter(Boolean) : [];
  } catch { return []; }
};

const toRow = (raw: Record<string, unknown>): TrajectoryDeltaRow => ({
  id: String(raw.id), projectId: (raw.project_id as string | null) ?? null,
  threadId: (raw.thread_id as string | null) ?? null, workflowId: (raw.workflow_id as string | null) ?? null,
  stageArchetype: String(raw.stage_archetype), interventionKind: String(raw.intervention_kind) as TrajectoryInterventionKind,
  resolvedSkills: parseSkills(raw.resolved_skills_json as string | null), maskedSummary: String(raw.masked_summary),
  ownerAccepted: Number(raw.owner_accepted) === 1,
  processedAt: raw.processed_at === null || raw.processed_at === undefined ? null : Number(raw.processed_at),
  createdAt: Number(raw.created_at),
});

/** Records one masked owner trajectory delta idempotently into `lane_pilot_trajectory_delta`. */
export function recordTrajectoryDelta(db: DbLike, input: RecordTrajectoryDeltaInput): RecordTrajectoryDeltaResult {
  const warnSink = input.warn ?? input.log;
  if (!KIND_SET.has(input.interventionKind)) {
    emit(warnSink, "warn", "rejected", { reason: "invalid_kind", kind: String(input.interventionKind) }, input.logLevel);
    return { status: "rejected", row: null, reason: "invalid_kind" };
  }
  const trimmed = (input.rawSummary ?? "").trim();
  if (!trimmed) {
    emit(warnSink, "warn", "rejected", { reason: "empty_summary", kind: input.interventionKind }, input.logLevel);
    return { status: "rejected", row: null, reason: "empty_summary" };
  }

  let maskedSummary: string;
  try {
    maskedSummary = maskPii(scrubQuote(redactKnown(trimmed), SUMMARY_CLIP)).text.trim();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    emit(warnSink, "error", "mask_failed", { kind: input.interventionKind, error: message.slice(0, 160) }, input.logLevel);
    return { status: "rejected", row: null, reason: "mask_failed" };
  }
  if (!maskedSummary) {
    emit(warnSink, "warn", "rejected", { reason: "empty_after_mask", kind: input.interventionKind }, input.logLevel);
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
  const row = stored ? toRow(stored) : null;
  if (res.changes === 0) {
    emit(input.log, "debug", "duplicate", { id, kind: input.interventionKind, stageArchetype }, input.logLevel);
    return { status: "duplicate", row };
  }
  emit(input.log, "info", "recorded", { id, kind: input.interventionKind, stageArchetype, skillsCount: resolvedSkills.length }, input.logLevel);
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
    return rows.map(toRow);
  }
  const rows = db.prepare(
    `SELECT * FROM lane_pilot_trajectory_delta
     WHERE processed_at IS NULL AND (? = 0 OR owner_accepted = 1)
     ORDER BY created_at ASC, id ASC LIMIT ?`,
  ).all(onlyAccepted ? 1 : 0, limit) as Array<Record<string, unknown>>;
  return rows.map(toRow);
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
  if (updated > 0) emit(log, "info", "processed", { count: updated, processedAt });
  return updated;
}
