import { memoryVisibilitySql, type MemoryDatabase, type MemoryScopeMode } from "@lane-pilot/memory-core";
import type { LanePilotDatabase } from "../../../storage";

export type ActiveImportMemoryRow = {
  id: string;
  kind: string;
  content: string;
  concepts_json: string;
  valid_from: number | null;
  created_at: number;
};

export function listActiveMemoryForImport(db: MemoryDatabase, projectId: string): ActiveImportMemoryRow[] {
  return db.prepare("SELECT id,kind,content,concepts_json,valid_from,created_at FROM lane_pilot_memory WHERE project_id=? AND status='active'")
    .all(projectId) as ActiveImportMemoryRow[];
}

export type ActiveConflictNoteRow = {
  id: string;
  audience: string;
  personal_bot: string;
  content: string;
  concepts_json: string;
  created_at: number;
  scope_json: string | null;
};

export function listActiveNotesForConflicts(db: LanePilotDatabase, projectId: string): ActiveConflictNoteRow[] {
  return db.prepare("SELECT id,audience,personal_bot,content,concepts_json,created_at,scope_json FROM lane_pilot_memory WHERE project_id=? AND status='active'")
    .all(projectId) as ActiveConflictNoteRow[];
}

export function getMemoryCreatedAt(db: LanePilotDatabase, projectId: string, id: string): number {
  return (db.prepare("SELECT created_at FROM lane_pilot_memory WHERE project_id=? AND id=?").get(projectId, id) as { created_at: number } | undefined)?.created_at ?? 0;
}

export function getMemoryFingerprintRow(db: LanePilotDatabase, projectId: string, id: string): { content: string; file_fingerprint: string | null } | undefined {
  return db.prepare("SELECT content, file_fingerprint FROM lane_pilot_memory WHERE project_id=? AND id=?").get(projectId, id) as { content: string; file_fingerprint: string | null } | undefined;
}

export function isMemoryRecordActive(db: LanePilotDatabase, projectId: string, id: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_memory WHERE project_id=? AND id=? AND status='active'").get(projectId, id));
}

/** Projects that have active notes: the audit without `--project` reads all of them. */
export function projectsWithNotes(db: MemoryDatabase): string[] {
  return (db.prepare("SELECT DISTINCT project_id FROM lane_pilot_memory WHERE kind='note' AND status='active' ORDER BY project_id").all() as Array<{ project_id: string }>).map((row) => row.project_id);
}

export function listCoreMemoryForSession(
  db: LanePilotDatabase,
  projectId: string,
  personalBot: string,
  chain: readonly string[],
  scopeMode: MemoryScopeMode,
): Array<{ id: string; content: string }> {
  return db.prepare(`SELECT id, content FROM lane_pilot_memory m WHERE m.project_id=? AND m.kind='core' AND m.audience='subagent' AND m.personal_bot=? AND ${memoryVisibilitySql(db, "m", { chain, scopeMode })} ORDER BY m.accepted_count DESC, m.use_count DESC, m.created_at DESC`)
    .all(projectId, personalBot) as Array<{ id: string; content: string }>;
}

export function listCoreScopes(db: LanePilotDatabase, projectId: string, personalBot: string): Array<{ scope_json: string | null }> {
  return db.prepare(`SELECT DISTINCT scope_json FROM lane_pilot_memory
    WHERE project_id=? AND personal_bot=? AND kind='core' AND audience='subagent' AND status='active'`).all(projectId, personalBot) as Array<{ scope_json: string | null }>;
}
