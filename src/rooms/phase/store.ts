import { withoutSelectionMarkers } from "../native-agent/native-session";
import type Database from "better-sqlite3";
import { GENESIS, partHash, type BookPart, type BookSection, type Phase, type PhaseRecord, type PhaseStage, type PhaseState } from "./logic";

export type PhaseDb = Pick<Database.Database, "prepare" | "transaction">;

type Raw = {
  id: string; project_id: string; pm_thread_id: string; run_id: string | null; title: string; goal: string; stage: PhaseStage; state: PhaseState;
  record_json: string; edition: number; poked_key: string | null; poked_at: number | null; created_at: number; updated_at: number; closed_at: number | null;
};

const parse = <T>(text: string, fallback: T): T => { try { return JSON.parse(text) as T; } catch { return fallback; } };

const phaseOf = (row: Raw): Phase & { pokedKey: string | null } => ({
  id: row.id, projectId: row.project_id, pmThreadId: row.pm_thread_id, runId: row.run_id, title: withoutSelectionMarkers(row.title), goal: withoutSelectionMarkers(row.goal), stage: row.stage, state: row.state,
  record: parse<PhaseRecord>(row.record_json, {}), edition: row.edition, createdAt: row.created_at, updatedAt: row.updated_at, pokedKey: row.poked_key,
});

export function insertPhase(db: PhaseDb, phase: Pick<Phase, "id" | "projectId" | "pmThreadId" | "title" | "goal"> & { runId?: string | null; at: number }): void {
  db.prepare(`INSERT INTO lane_pilot_phase(id,project_id,pm_thread_id,run_id,title,goal,stage,state,record_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'discussion','active','{}',?,?)`).run(phase.id, phase.projectId, phase.pmThreadId, phase.runId ?? null, phase.title, phase.goal, phase.at, phase.at);
}

export function getPhase(db: PhaseDb, id: string): (Phase & { pokedKey: string | null }) | undefined {
  const row = db.prepare("SELECT * FROM lane_pilot_phase WHERE id=?").get(id) as Raw | undefined;
  return row ? phaseOf(row) : undefined;
}

export function listPhases(db: PhaseDb, filter: { pmThreadId?: string; projectId?: string; live?: boolean; limit?: number } = {}): Array<Phase & { pokedKey: string | null }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.pmThreadId) { where.push("pm_thread_id=?"); args.push(filter.pmThreadId); }
  if (filter.projectId) { where.push("project_id=?"); args.push(filter.projectId); }
  if (filter.live) where.push("state NOT IN ('closed','stopped')");
  const sql = `SELECT * FROM lane_pilot_phase${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, filter.limit ?? 50) as Raw[]).map(phaseOf);
}

/** Writes a new stage, state, record or run of the phase; the edition grows when the record changes. */
export function savePhase(db: PhaseDb, id: string, patch: { stage?: PhaseStage; state?: PhaseState; record?: PhaseRecord; runId?: string | null; at: number }): void {
  const current = getPhase(db, id);
  if (!current) throw new Error(`no phase ${id}`);
  const record = patch.record ?? current.record;
  const changed = JSON.stringify(record) !== JSON.stringify(current.record);
  db.prepare(`UPDATE lane_pilot_phase SET stage=?, state=?, record_json=?, run_id=?, edition=edition+?, updated_at=?, closed_at=CASE WHEN ? IN ('closed','stopped') THEN ? ELSE closed_at END WHERE id=?`)
    .run(patch.stage ?? current.stage, patch.state ?? current.state, JSON.stringify(record), patch.runId === undefined ? current.runId : patch.runId, changed ? 1 : 0, patch.at,
      patch.state ?? current.state, patch.at, id);
}

/** Remembers the last instruction sent to the PM, so the same one is not sent twice. */
export function notePoked(db: PhaseDb, id: string, key: string, at: number): void {
  db.prepare("UPDATE lane_pilot_phase SET poked_key=?, poked_at=? WHERE id=?").run(key, at, id);
}

type RawPart = { seq: number; at: number; section: BookSection; kind: string; text: string; prev_hash: string; hash: string };

export function listParts(db: PhaseDb, phaseId: string): BookPart[] {
  return (db.prepare("SELECT seq, at, section, kind, text, prev_hash, hash FROM lane_pilot_phase_part WHERE phase_id=? ORDER BY seq").all(phaseId) as RawPart[])
    .map((row) => ({ seq: row.seq, at: row.at, section: row.section, kind: row.kind, text: row.text, prevHash: row.prev_hash, hash: row.hash }));
}

/** Appends one part to the phase book, chained to the part before it. */
export function appendPart(db: PhaseDb, phaseId: string, part: { section: BookSection; kind: string; text: string; at: number }): BookPart {
  return db.transaction(() => {
    const last = db.prepare("SELECT seq, hash FROM lane_pilot_phase_part WHERE phase_id=? ORDER BY seq DESC LIMIT 1").get(phaseId) as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS;
    const text = part.text.slice(0, 4000);
    const hash = partHash(prevHash, { seq, at: part.at, section: part.section, kind: part.kind, text });
    db.prepare("INSERT INTO lane_pilot_phase_part(phase_id,seq,at,section,kind,text,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?)").run(phaseId, seq, part.at, part.section, part.kind, text, prevHash, hash);
    return { seq, at: part.at, section: part.section, kind: part.kind, text, prevHash, hash };
  })();
}
