import type { MemoryDatabase } from "./store";
import type { Conflict, ConflictKind } from "./conflicts";
import { conflictId } from "./conflicts";

/**
 * The register of memory conflicts (SMA block 4, P2-7): two active notes that disagree are HELD, both, until a person settles it.
 * A held note is invisible to every reader of memory (search, the writer's brief, the reviewers, the PM tool, the terminal's core
 * block, the exported lane-memory files) through one clause (`heldClause`), not through a flag each reader has to remember. The
 * notes stay `active` in the table, so the budget keeps counting them and nothing is lost.
 *
 * Why hold both rather than inject both with a «conflict, owner to settle» marker: an agent cannot weigh two facts neither of which
 * it can check, a marker invites a guess and costs tokens in every brief that carries it, and a wrong «fact» is worse than a missing
 * one (the code stays the source and the task's read list points at it). The conflict is shown to the owner through the deferral
 * register (kind `memory_conflict`) instead.
 */
export const memoryConflictMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_memory_conflict (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    personal_bot TEXT NOT NULL DEFAULT '',
    note_a TEXT NOT NULL,
    note_b TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('value','polarity','literal')),
    subject TEXT NOT NULL,
    evidence_a TEXT NOT NULL DEFAULT '',
    evidence_b TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK(state IN ('held','settled')),
    resolution TEXT CHECK(resolution IN ('keep_a','keep_b','keep_both','drop_both','moot')),
    deferral_id TEXT,
    detected_at INTEGER NOT NULL,
    settled_at INTEGER,
    settled_by TEXT,
    UNIQUE(project_id, note_a, note_b)
  )`,
  `CREATE INDEX lane_pilot_memory_conflict_state ON lane_pilot_memory_conflict(project_id, state)`,
];

export type ConflictResolution = "keep_a" | "keep_b" | "keep_both" | "drop_both" | "moot";
export type ConflictRow = {
  id: string; projectId: string; personalBot: string; noteA: string; noteB: string; kind: ConflictKind; subject: string;
  evidenceA: string; evidenceB: string; state: "held" | "settled"; resolution: ConflictResolution | null; deferralId: string | null;
  detectedAt: number; settledAt: number | null; settledBy: string | null;
};
type Raw = { id: string; project_id: string; personal_bot: string; note_a: string; note_b: string; kind: ConflictKind; subject: string; evidence_a: string; evidence_b: string;
  state: "held" | "settled"; resolution: ConflictResolution | null; deferral_id: string | null; detected_at: number; settled_at: number | null; settled_by: string | null };
const fromRaw = (row: Raw): ConflictRow => ({ id: row.id, projectId: row.project_id, personalBot: row.personal_bot, noteA: row.note_a, noteB: row.note_b, kind: row.kind, subject: row.subject,
  evidenceA: row.evidence_a, evidenceB: row.evidence_b, state: row.state, resolution: row.resolution, deferralId: row.deferral_id, detectedAt: row.detected_at, settledAt: row.settled_at, settledBy: row.settled_by });

const ready = new WeakSet<object>();
/** True where the register's table exists (a database from before it, or a package test with its own schema, has none). */
export function conflictTableReady(db: MemoryDatabase): boolean {
  if (ready.has(db)) return true;
  const found = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lane_pilot_memory_conflict'").get());
  if (found) ready.add(db);
  return found;
}

/**
 * The SQL fragment (starting with ` AND`) that leaves out the notes of a held conflict; empty where the register does not exist.
 * `alias` names the memory table in the query it is added to.
 */
export function heldClause(db: MemoryDatabase, alias: string): string {
  if (!conflictTableReady(db)) return "";
  return ` AND NOT EXISTS (SELECT 1 FROM lane_pilot_memory_conflict hc WHERE hc.state='held' AND hc.project_id=${alias}.project_id AND (hc.note_a=${alias}.id OR hc.note_b=${alias}.id))`;
}

/** Writes a found conflict as held; a pair the register already knows (held or settled) is left as it is. Returns the row when it is new. */
export function holdConflict(db: MemoryDatabase, input: { projectId: string; personalBot?: string; conflict: Conflict; now: number }): ConflictRow | null {
  const { conflict } = input;
  const [a, b] = [conflict.a, conflict.b].sort();
  const id = conflictId(a!, b!);
  const result = db.prepare(`INSERT OR IGNORE INTO lane_pilot_memory_conflict(id,project_id,personal_bot,note_a,note_b,kind,subject,evidence_a,evidence_b,state,detected_at)
    VALUES(?,?,?,?,?,?,?,?,?,'held',?)`).run(id, input.projectId, input.personalBot ?? "", a, b, conflict.kind, conflict.subject.slice(0, 200),
    (conflict.a === a ? conflict.evidenceA : conflict.evidenceB).slice(0, 300), (conflict.a === a ? conflict.evidenceB : conflict.evidenceA).slice(0, 300), input.now);
  return result.changes ? getConflict(db, id) : null;
}

export function getConflict(db: MemoryDatabase, id: string): ConflictRow | null {
  const row = db.prepare("SELECT * FROM lane_pilot_memory_conflict WHERE id=?").get(id) as Raw | undefined;
  return row ? fromRaw(row) : null;
}

export function listConflicts(db: MemoryDatabase, filter: { projectId?: string | undefined; state?: "held" | "settled" | undefined } = {}): ConflictRow[] {
  const where: string[] = [], args: unknown[] = [];
  if (filter.projectId) { where.push("project_id=?"); args.push(filter.projectId); }
  if (filter.state) { where.push("state=?"); args.push(filter.state); }
  return (db.prepare(`SELECT * FROM lane_pilot_memory_conflict${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY detected_at, id`).all(...args) as Raw[]).map(fromRaw);
}

export function setDeferral(db: MemoryDatabase, id: string, deferralId: string): void {
  db.prepare("UPDATE lane_pilot_memory_conflict SET deferral_id=? WHERE id=?").run(deferralId, id);
}

export function markSettled(db: MemoryDatabase, id: string, resolution: ConflictResolution, evidence: string, now: number): boolean {
  return db.prepare("UPDATE lane_pilot_memory_conflict SET state='settled', resolution=?, settled_at=?, settled_by=? WHERE id=? AND state='held'").run(resolution, now, evidence, id).changes === 1;
}
