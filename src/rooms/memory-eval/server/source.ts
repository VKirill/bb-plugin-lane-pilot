import Database from "better-sqlite3";

/**
 * Where the evaluation takes real data from: the notes the hub holds and the accepted tasks with the files their accepted attempt
 * actually produced. Read only. Two shapes, one reading: the live plugin database (`lane_pilot_*` tables), or an extract file made
 * by `exportEvalExtract` (two tables, `memory` and `question`) so the run can happen on any machine without the hub's 500 MB database.
 */
export type RawNote = {
  id: string; projectId: string; kind: "core" | "note"; content: string; concepts: string[]; createdAt: number;
  status: string; trust: string; origin: string; useCount: number; acceptedCount: number;
};
export type RawTask = { title: string; objective: string; acceptance: string[]; owns_paths: string[]; read_first: string[] };
export type RawQuestion = {
  attemptId: string; taskId: string; projectId: string; startedAt: number; attemptNo: number;
  /** The files the accepted attempt changed (the acceptance receipt's `produced`). */
  produced: string[];
  /** The ids of the notes the brief of that attempt carried (what the writer actually read). */
  picked: string[];
  task: RawTask;
};
export type EvalData = { notes: RawNote[]; questions: RawQuestion[]; origin: "live" | "extract" };

type Reader = Pick<Database.Database, "prepare">;

const MEMORY_SQL = "SELECT id,project_id,kind,content,concepts_json,created_at,status,trust,origin,use_count,accepted_count FROM lane_pilot_memory";
const QUESTION_SQL = `SELECT a.id AS attempt_id, a.task_id AS task_id, r.project_id AS project_id, a.created_at AS started_at, a.attempt_no AS attempt_no,
    json_extract(rc.result_json,'$.produced') AS produced_json,
    json_extract(rr.trace_json,'$.dispatchContext.memoryPicked') AS picked_json,
    t.contract_json AS contract_json
  FROM lane_pilot_attempt a
  JOIN lane_pilot_run r ON r.id=a.run_id
  JOIN lane_pilot_task t ON t.id=a.task_id
  JOIN lane_pilot_stage_receipt rc ON rc.run_id=a.run_id AND rc.task_id=a.task_id AND rc.stage_id='acceptance-receipt' AND rc.state='passed'
    AND json_extract(rc.result_json,'$.attemptId')=a.id
  LEFT JOIN lane_pilot_attempt_reasoning rr ON rr.attempt_id=a.id
  WHERE a.state='accepted' ORDER BY a.created_at`;

type NoteRow = { id: string; project_id: string; kind: "core" | "note"; content: string; concepts_json: string; created_at: number; status: string; trust: string; origin: string; use_count: number; accepted_count: number };
type QuestionRow = { attempt_id: string; task_id: string; project_id: string; started_at: number; attempt_no: number; produced_json: string | null; picked_json: string | null; contract_json: string };

const list = (text: string | null): unknown[] => {
  if (!text) return [];
  try { const value = JSON.parse(text) as unknown; return Array.isArray(value) ? value : []; } catch { return []; }
};
const strings = (value: unknown): string[] => (Array.isArray(value) ? value : [])
  .map((item) => typeof item === "string" ? item : (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" ? (item as { path: string }).path : ""))
  .filter(Boolean);

function task(contractJson: string): RawTask {
  let contract: Record<string, unknown> = {};
  try { contract = JSON.parse(contractJson) as Record<string, unknown>; } catch { /* an unreadable contract is a task with no words */ }
  const text = (value: unknown) => typeof value === "string" ? value : "";
  return { title: text(contract.title), objective: text(contract.objective), acceptance: strings(contract.acceptance), owns_paths: strings(contract.owns_paths), read_first: strings(contract.read_first) };
}

const toNote = (row: NoteRow): RawNote => ({ id: row.id, projectId: row.project_id, kind: row.kind, content: row.content, concepts: list(row.concepts_json).filter((item): item is string => typeof item === "string"),
  createdAt: row.created_at, status: row.status, trust: row.trust, origin: row.origin, useCount: row.use_count ?? 0, acceptedCount: row.accepted_count ?? 0 });
const toQuestion = (row: QuestionRow): RawQuestion => ({ attemptId: row.attempt_id, taskId: row.task_id, projectId: row.project_id, startedAt: row.started_at, attemptNo: row.attempt_no,
  produced: strings(list(row.produced_json)), picked: strings(list(row.picked_json)), task: task(row.contract_json) });

const hasTable = (db: Reader, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

/** Reads the data from the live plugin database or from an extract; never writes. */
export function loadEvalData(db: Reader): EvalData {
  if (hasTable(db, "question") && hasTable(db, "memory") && !hasTable(db, "lane_pilot_memory")) {
    return {
      origin: "extract",
      notes: (db.prepare("SELECT id,project_id,kind,content,concepts_json,created_at,status,trust,origin,use_count,accepted_count FROM memory").all() as NoteRow[]).map(toNote),
      questions: (db.prepare("SELECT * FROM question ORDER BY started_at").all() as QuestionRow[]).map(toQuestion),
    };
  }
  return { origin: "live", notes: (db.prepare(MEMORY_SQL).all() as NoteRow[]).map(toNote), questions: (db.prepare(QUESTION_SQL).all() as QuestionRow[]).map(toQuestion) };
}

/** Writes the extract file a run can read later (`memory-eval --source`); the live database is only read. */
export function exportEvalExtract(live: Reader, path: string): { notes: number; questions: number } {
  const data = loadEvalData(live);
  const out = new Database(path);
  try {
    out.exec(`CREATE TABLE memory (id TEXT, project_id TEXT, kind TEXT, content TEXT, concepts_json TEXT, created_at INTEGER, status TEXT, trust TEXT, origin TEXT, use_count INTEGER, accepted_count INTEGER);
      CREATE TABLE question (attempt_id TEXT, task_id TEXT, project_id TEXT, started_at INTEGER, attempt_no INTEGER, produced_json TEXT, picked_json TEXT, contract_json TEXT);`);
    const note = out.prepare("INSERT INTO memory VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    const question = out.prepare("INSERT INTO question VALUES (?,?,?,?,?,?,?,?)");
    out.transaction(() => {
      for (const row of data.notes) note.run(row.id, row.projectId, row.kind, row.content, JSON.stringify(row.concepts), row.createdAt, row.status, row.trust, row.origin, row.useCount, row.acceptedCount);
      for (const row of data.questions) question.run(row.attemptId, row.taskId, row.projectId, row.startedAt, row.attemptNo, JSON.stringify(row.produced), JSON.stringify(row.picked), JSON.stringify(row.task));
    })();
  } finally { out.close(); }
  return { notes: data.notes.length, questions: data.questions.length };
}
