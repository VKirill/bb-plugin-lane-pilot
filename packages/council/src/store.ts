import type Database from "better-sqlite3";
import type { CouncilMessage, CouncilMessageKind, CouncilSeat, CouncilSession, CouncilState, DecisionRecord } from "./contract";

export type CouncilDatabase = Pick<Database.Database, "prepare" | "transaction">;

export const councilMigrations: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lane_pilot_council (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    question TEXT NOT NULL,
    agenda_json TEXT NOT NULL,
    criteria_json TEXT NOT NULL,
    seats_json TEXT NOT NULL,
    state TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 0,
    max_rounds INTEGER NOT NULL,
    decision_json TEXT,
    decision_path TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_council_project ON lane_pilot_council(project_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS lane_pilot_council_message (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    council_id TEXT NOT NULL REFERENCES lane_pilot_council(id) ON DELETE CASCADE,
    seat_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
];

type Row = {
  id: string; project_id: string; run_id: string; question: string; agenda_json: string; criteria_json: string; seats_json: string;
  state: CouncilState; round: number; max_rounds: number; decision_json: string | null; decision_path: string | null; reason: string | null; created_at: number; updated_at: number;
};

const SELECT = "SELECT id,project_id,run_id,question,agenda_json,criteria_json,seats_json,state,round,max_rounds,decision_json,decision_path,reason,created_at,updated_at FROM lane_pilot_council";

function toSession(row: Row): CouncilSession {
  return {
    id: row.id, projectId: row.project_id, runId: row.run_id, question: row.question,
    agenda: JSON.parse(row.agenda_json) as string[], criteria: JSON.parse(row.criteria_json) as string[], seats: JSON.parse(row.seats_json) as CouncilSeat[],
    state: row.state, round: row.round, maxRounds: row.max_rounds,
    decision: row.decision_json ? (JSON.parse(row.decision_json) as DecisionRecord) : null, decisionPath: row.decision_path, reason: row.reason,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createCouncilSession(db: CouncilDatabase, input: { id: string; projectId: string; runId: string; question: string; seats: CouncilSeat[]; maxRounds: number; now?: number }): CouncilSession {
  const now = input.now ?? Date.now();
  db.prepare(`INSERT INTO lane_pilot_council(id,project_id,run_id,question,agenda_json,criteria_json,seats_json,state,round,max_rounds,created_at,updated_at)
    VALUES(?,?,?,?,'[]','[]',?,'agenda',0,?,?,?)`).run(input.id, input.projectId, input.runId, input.question, JSON.stringify(input.seats), input.maxRounds, now, now);
  return getCouncilSession(db, input.id)!;
}

export function getCouncilSession(db: CouncilDatabase, id: string): CouncilSession | null {
  const row = db.prepare(`${SELECT} WHERE id=?`).get(id) as Row | undefined;
  return row ? toSession(row) : null;
}

export function listCouncilSessions(db: CouncilDatabase, filter: { projectId: string; runId?: string; limit?: number }): CouncilSession[] {
  const rows = filter.runId
    ? db.prepare(`${SELECT} WHERE project_id=? AND run_id=? ORDER BY updated_at DESC LIMIT ?`).all(filter.projectId, filter.runId, filter.limit ?? 50) as Row[]
    : db.prepare(`${SELECT} WHERE project_id=? ORDER BY updated_at DESC LIMIT ?`).all(filter.projectId, filter.limit ?? 50) as Row[];
  return rows.map(toSession);
}

export function setCouncilAgenda(db: CouncilDatabase, id: string, agenda: string[], criteria: string[], now = Date.now()): void {
  db.prepare("UPDATE lane_pilot_council SET agenda_json=?, criteria_json=?, updated_at=? WHERE id=?").run(JSON.stringify(agenda), JSON.stringify(criteria), now, id);
}

export function setCouncilState(db: CouncilDatabase, id: string, patch: { state?: CouncilState; round?: number; decision?: DecisionRecord | null; decisionPath?: string | null; reason?: string | null }, now = Date.now()): void {
  const sets: string[] = ["updated_at=?"];
  const params: unknown[] = [now];
  if (patch.state !== undefined) { sets.push("state=?"); params.push(patch.state); }
  if (patch.round !== undefined) { sets.push("round=?"); params.push(patch.round); }
  if (patch.decision !== undefined) { sets.push("decision_json=?"); params.push(patch.decision ? JSON.stringify(patch.decision) : null); }
  if (patch.decisionPath !== undefined) { sets.push("decision_path=?"); params.push(patch.decisionPath); }
  if (patch.reason !== undefined) { sets.push("reason=?"); params.push(patch.reason); }
  params.push(id);
  db.prepare(`UPDATE lane_pilot_council SET ${sets.join(", ")} WHERE id=?`).run(...params);
}

export function addCouncilMessage(db: CouncilDatabase, input: { councilId: string; seatId: string; round: number; kind: CouncilMessageKind; text: string; at?: number }): CouncilMessage {
  const at = input.at ?? Date.now();
  const result = db.prepare("INSERT INTO lane_pilot_council_message(council_id,seat_id,round,kind,text,at) VALUES(?,?,?,?,?,?)").run(input.councilId, input.seatId, input.round, input.kind, input.text, at);
  db.prepare("UPDATE lane_pilot_council SET updated_at=? WHERE id=?").run(at, input.councilId);
  return { seq: Number(result.lastInsertRowid), councilId: input.councilId, seatId: input.seatId, round: input.round, kind: input.kind, text: input.text, at };
}

export function listCouncilMessages(db: CouncilDatabase, councilId: string, afterSeq = 0): CouncilMessage[] {
  const rows = db.prepare("SELECT seq,council_id,seat_id,round,kind,text,at FROM lane_pilot_council_message WHERE council_id=? AND seq>? ORDER BY seq ASC").all(councilId, afterSeq) as Array<{ seq: number; council_id: string; seat_id: string; round: number; kind: CouncilMessageKind; text: string; at: number }>;
  return rows.map((row) => ({ seq: row.seq, councilId: row.council_id, seatId: row.seat_id, round: row.round, kind: row.kind, text: row.text, at: row.at }));
}
