import type { MemoryDatabase } from "./store";

// Small database helpers the eval corpus, the probe and the shelves read (split out of store.ts to keep it under its size ceiling; store.ts re-exports them).
/** One memory row written the way the eval corpus seeds it (direct INSERT, no write-door side effects). */
export function insertMemoryRecord(db: MemoryDatabase, input: { id: string; projectId: string; kind: string; content: string; conceptsJson: string; sourceSha256: string; createdAt: number; origin: string }): void {
  db.prepare(`INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin)
    VALUES(?,?,'',?,'subagent',?,?,?,?,'confirmed',?)`)
    .run(input.id, input.projectId, input.kind, input.content, input.conceptsJson, input.sourceSha256, input.createdAt, input.origin);
}

/** Active notes with exactly this content in a project (the eval gate's duplicate check). */
export function countActiveMemoryByContent(db: MemoryDatabase, projectId: string, content: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory WHERE project_id=? AND status='active' AND content=?").get(projectId, content) as { n: number }).n;
}

/** A record's trust (the eval gate). */
export function memoryTrustOf(db: MemoryDatabase, id: string): string | undefined {
  return (db.prepare("SELECT trust FROM lane_pilot_memory WHERE id=?").get(id) as { trust: string } | undefined)?.trust;
}

/** id/scope_json of every record (the eval's scope audit). */
export function listMemoryScopeRows(db: MemoryDatabase): Array<{ id: string; scope_json: string | null }> {
  return db.prepare("SELECT id, scope_json FROM lane_pilot_memory").all() as Array<{ id: string; scope_json: string | null }>;
}

/** Active note ids of a project (the eval shelf). */
export function listActiveNoteIds(db: MemoryDatabase, projectId: string): string[] {
  return (db.prepare("SELECT id FROM lane_pilot_memory WHERE project_id=? AND status='active' AND kind='note'").all(projectId) as Array<{ id: string }>).map((row) => row.id);
}

/** Active note count overall (the eval shelf). */
export function countActiveNotes(db: MemoryDatabase): number {
  return (db.prepare("SELECT count(*) n FROM lane_pilot_memory WHERE status='active' AND kind='note'").get() as { n: number }).n;
}

/** Any project's id besides the given one (the probe's cross-project check). */
export function otherMemoryProjectId(db: MemoryDatabase, projectId: string): string | undefined {
  return (db.prepare("SELECT project_id FROM lane_pilot_memory WHERE project_id != ? LIMIT 1").get(projectId) as { project_id: string } | undefined)?.project_id;
}

/** Record ids a project wrote with a given origin (the probe's cleanup). */
export function listMemoryIdsByOrigin(db: MemoryDatabase, projectId: string, origin: string, naming?: string): string[] {
  const rows = naming === undefined
    ? db.prepare("SELECT id FROM lane_pilot_memory WHERE project_id=? AND origin=?").all(projectId, origin)
    : db.prepare("SELECT id FROM lane_pilot_memory WHERE project_id=? AND origin=? AND instr(content, ?) > 0").all(projectId, origin, naming);
  return (rows as Array<{ id: string }>).map((row) => row.id);
}

/** One memory-probe result row. */
export function recordMemoryProbe(db: MemoryDatabase, row: { at: number; projectId: string; token: string; path: string; found: boolean; negativeOk: boolean | null; latencyMs: number; lpVersion: string; detail: string }): void {
  db.prepare("INSERT INTO lane_pilot_memory_probe(at,project_id,token,path,found,negative_ok,latency_ms,lp_version,detail) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(row.at, row.projectId, row.token, row.path, row.found ? 1 : 0, row.negativeOk === null ? null : row.negativeOk ? 1 : 0, row.latencyMs, row.lpVersion, row.detail);
}

/** The last probe run's rows per path (the probe report). */
export function latestMemoryProbeRows(db: MemoryDatabase, projectId: string): Array<{ path: string; found: number; negativeOk: number | null; latencyMs: number; lpVersion: string; at: number; detail: string }> {
  return db.prepare(`SELECT path, found, negative_ok AS negativeOk, latency_ms AS latencyMs, lp_version AS lpVersion, at, detail FROM lane_pilot_memory_probe
    WHERE project_id=? AND at=(SELECT max(at) FROM lane_pilot_memory_probe WHERE project_id=?) ORDER BY path`).all(projectId, projectId) as
    Array<{ path: string; found: number; negativeOk: number | null; latencyMs: number; lpVersion: string; at: number; detail: string }>;
}

/** Probe rows older than a time leave at boot (the outage prune). */
export function pruneMemoryProbeBefore(db: MemoryDatabase, beforeMs: number): void {
  db.prepare("DELETE FROM lane_pilot_memory_probe WHERE at < ?").run(beforeMs);
}
