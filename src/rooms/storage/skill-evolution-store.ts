import type Database from "better-sqlite3";
import { id, redactKnown, shouldLogLevel } from "@lane-pilot/kit";

export type SkillEvolutionStatus = "staged" | "published" | "rolled_back";

export type SkillEvolutionFileEntry = {
  path: string;
  text: string;
};

export type SupersededWorkflowSnapshot = {
  workflowId: string;
  path: string;
  content: string;
  sha256: string;
};

export type SkillEvolutionEventInput = {
  evolutionId?: string;
  draftId: string;
  draftVersion: number;
  workflowId: string;
  skillId: string;
  operator: string;
  mergeMode: string;
  status: SkillEvolutionStatus;
  candidateFiles: readonly SkillEvolutionFileEntry[];
  beforeFiles?: readonly SkillEvolutionFileEntry[] | null;
  beforeBundleSha256?: string | null;
  afterBundleSha256?: string | null;
  supersededWorkflowIds?: readonly string[];
  supersededSnapshots?: readonly SupersededWorkflowSnapshot[];
  createdAt?: number;
};

export type SkillEvolutionRow = {
  evolutionId: string;
  draftId: string;
  draftVersion: number;
  workflowId: string;
  skillId: string;
  operator: string;
  mergeMode: string;
  status: SkillEvolutionStatus;
  candidateFiles: SkillEvolutionFileEntry[];
  beforeFiles: SkillEvolutionFileEntry[] | null;
  beforeBundleSha256: string | null;
  afterBundleSha256: string | null;
  supersededWorkflowIds: string[];
  supersededSnapshots: SupersededWorkflowSnapshot[];
  createdAt: number;
};

export type SkillEvolutionStoreOptions = {
  log?: (message: string) => void;
};

type RawEvolutionRow = {
  evolution_id: string;
  draft_id: string;
  draft_version: number;
  workflow_id: string;
  skill_id: string;
  operator: string;
  merge_mode: string;
  status: SkillEvolutionStatus;
  candidate_files_json: string;
  before_files_json: string | null;
  before_bundle_sha256: string | null;
  after_bundle_sha256: string | null;
  superseded_workflow_ids_json: string;
  superseded_snapshots_json: string;
  created_at: number;
};

function emitLog(
  options: SkillEvolutionStoreOptions | undefined,
  level: "debug" | "info" | "warn",
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!options?.log || !shouldLogLevel(level)) return;
  options.log(`${level.toUpperCase()} [storage.skillEvolution] ${event} ${redactKnown(JSON.stringify(payload))}`);
}

const isFileEntry = (v: unknown): v is SkillEvolutionFileEntry =>
  Boolean(v) && typeof v === "object" && typeof (v as SkillEvolutionFileEntry).path === "string" && typeof (v as SkillEvolutionFileEntry).text === "string";

const isSnapshot = (v: unknown): v is SupersededWorkflowSnapshot =>
  Boolean(v) && typeof v === "object"
  && typeof (v as SupersededWorkflowSnapshot).workflowId === "string"
  && typeof (v as SupersededWorkflowSnapshot).path === "string"
  && typeof (v as SupersededWorkflowSnapshot).content === "string"
  && typeof (v as SupersededWorkflowSnapshot).sha256 === "string";

const isStr = (v: unknown): v is string => typeof v === "string";

function parseJsonColumn<T>(
  raw: unknown,
  evolutionId: string,
  column: string,
  nullable: boolean,
  guard: (v: unknown) => v is T,
  options?: SkillEvolutionStoreOptions,
): T[] | null {
  if (raw === null || raw === undefined || raw === "") return nullable ? null : [];
  if (typeof raw !== "string") {
    emitLog(options, "warn", "corrupt_json_skipped", { evolutionId, column });
    return nullable ? null : [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (nullable && parsed === null) return null;
    if (!Array.isArray(parsed)) {
      emitLog(options, "warn", "corrupt_json_skipped", { evolutionId, column });
      return nullable ? null : [];
    }
    return parsed.filter(guard);
  } catch {
    emitLog(options, "warn", "corrupt_json_skipped", { evolutionId, column });
    return nullable ? null : [];
  }
}

function toSkillEvolutionRow(raw: RawEvolutionRow, options?: SkillEvolutionStoreOptions): SkillEvolutionRow {
  const evolutionId = String(raw.evolution_id);
  return {
    evolutionId,
    draftId: String(raw.draft_id),
    draftVersion: Number(raw.draft_version),
    workflowId: String(raw.workflow_id),
    skillId: String(raw.skill_id),
    operator: String(raw.operator),
    mergeMode: String(raw.merge_mode),
    status: raw.status,
    candidateFiles: parseJsonColumn(raw.candidate_files_json, evolutionId, "candidate_files_json", false, isFileEntry, options) ?? [],
    beforeFiles: parseJsonColumn(raw.before_files_json, evolutionId, "before_files_json", true, isFileEntry, options),
    beforeBundleSha256: raw.before_bundle_sha256 ?? null,
    afterBundleSha256: raw.after_bundle_sha256 ?? null,
    supersededWorkflowIds: parseJsonColumn(raw.superseded_workflow_ids_json, evolutionId, "superseded_workflow_ids_json", false, isStr, options) ?? [],
    supersededSnapshots: parseJsonColumn(raw.superseded_snapshots_json, evolutionId, "superseded_snapshots_json", false, isSnapshot, options) ?? [],
    createdAt: Number(raw.created_at),
  };
}

/** Appends an immutable skill evolution lifecycle event (`staged`, `published`, or `rolled_back`). */
export function appendSkillEvolutionEvent(
  db: Database.Database,
  input: SkillEvolutionEventInput,
  options?: SkillEvolutionStoreOptions,
): SkillEvolutionRow {
  const evolutionId = input.evolutionId?.trim() || id("skev");
  const createdAt = input.createdAt ?? Date.now();
  const candidateFiles = input.candidateFiles.map((f) => ({ path: f.path, text: f.text }));
  const beforeFiles = input.beforeFiles ? input.beforeFiles.map((f) => ({ path: f.path, text: f.text })) : null;
  const beforeBundleSha256 = input.beforeBundleSha256 ?? null;
  const afterBundleSha256 = input.afterBundleSha256 ?? null;
  const supersededWorkflowIds = [...(input.supersededWorkflowIds ?? [])];
  const supersededSnapshots = (input.supersededSnapshots ?? []).map((s) => ({
    workflowId: s.workflowId, path: s.path, content: s.content, sha256: s.sha256,
  }));

  db.prepare(`INSERT INTO lane_pilot_skill_evolution (
    evolution_id, draft_id, draft_version, workflow_id, skill_id, operator, merge_mode, status,
    candidate_files_json, before_files_json, before_bundle_sha256, after_bundle_sha256,
    superseded_workflow_ids_json, superseded_snapshots_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    evolutionId, input.draftId, input.draftVersion, input.workflowId, input.skillId, input.operator, input.mergeMode, input.status,
    JSON.stringify(candidateFiles), beforeFiles === null ? null : JSON.stringify(beforeFiles), beforeBundleSha256, afterBundleSha256,
    JSON.stringify(supersededWorkflowIds), JSON.stringify(supersededSnapshots), createdAt,
  );

  const row: SkillEvolutionRow = {
    evolutionId, draftId: input.draftId, draftVersion: input.draftVersion, workflowId: input.workflowId,
    skillId: input.skillId, operator: input.operator, mergeMode: input.mergeMode, status: input.status,
    candidateFiles, beforeFiles, beforeBundleSha256, afterBundleSha256, supersededWorkflowIds, supersededSnapshots, createdAt,
  };

  emitLog(options, input.status === "staged" ? "debug" : "info", input.status, {
    evolutionId: row.evolutionId, draftId: row.draftId, draftVersion: row.draftVersion, workflowId: row.workflowId,
    skillId: row.skillId, operator: row.operator, mergeMode: row.mergeMode, status: row.status,
    candidateFileCount: row.candidateFiles.length, beforeFileCount: row.beforeFiles?.length ?? 0,
    beforeBundleSha256: row.beforeBundleSha256, afterBundleSha256: row.afterBundleSha256,
    supersededWorkflowCount: row.supersededWorkflowIds.length, supersededSnapshotCount: row.supersededSnapshots.length, createdAt: row.createdAt,
  });

  return row;
}

/** Lists skill evolution events for a draft, newest first, with optional version and status filters. */
export function listSkillEvolutionsForDraft(
  db: Database.Database,
  draftId: string,
  options?: SkillEvolutionStoreOptions & { draftVersion?: number; status?: SkillEvolutionStatus },
): SkillEvolutionRow[] {
  const clauses = ["draft_id = ?"];
  const args: unknown[] = [draftId];
  if (options?.draftVersion !== undefined) { clauses.push("draft_version = ?"); args.push(options.draftVersion); }
  if (options?.status !== undefined) { clauses.push("status = ?"); args.push(options.status); }
  const rows = db.prepare(
    `SELECT * FROM lane_pilot_skill_evolution WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, rowid DESC`,
  ).all(...args) as RawEvolutionRow[];
  return rows.map((row) => toSkillEvolutionRow(row, options));
}

/** Returns the newest active `published` event per skill for a multi-skill draft (excluding rolled-back skills). */
export function listLatestActivePublishedSkillEvolutionsForDraft(
  db: Database.Database,
  draftId: string,
  options?: SkillEvolutionStoreOptions,
): SkillEvolutionRow[] {
  const rows = db.prepare(
    `SELECT * FROM lane_pilot_skill_evolution WHERE draft_id = ? AND status IN ('published', 'rolled_back') ORDER BY created_at DESC, rowid DESC`,
  ).all(draftId) as RawEvolutionRow[];
  const seenSkills = new Set<string>();
  const active: SkillEvolutionRow[] = [];
  for (const raw of rows) {
    if (seenSkills.has(raw.skill_id)) continue;
    seenSkills.add(raw.skill_id);
    if (raw.status === "published") active.push(toSkillEvolutionRow(raw, options));
  }
  return active;
}
