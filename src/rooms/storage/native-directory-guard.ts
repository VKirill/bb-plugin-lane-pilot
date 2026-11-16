import { realpathSync } from "node:fs";
import { wfRunRow } from "@lane-pilot/workflow-engine";
import type { LanePilotDatabase } from "./database";
import { getRun } from "./runs-store";

/** The move fence survives process restarts. Live admissions belong to the Core process executing their callbacks. */
export const nativeDirectoryMigrations = [
  `CREATE TABLE lane_pilot_directory_move (thread_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, record_json TEXT NOT NULL)`,
] as const;

export type DirectoryMove = {
  operationId: string; threadId: string; projectId: string;
  source: { environmentId: string; hostId: string; path: string };
  target: { environmentId: string; hostId: string; path: string };
  newRunId?: string;
};

export function directoryMove(db: LanePilotDatabase, threadId: string): DirectoryMove | null {
  const row = db.prepare("SELECT record_json FROM lane_pilot_directory_move WHERE thread_id=?").get(threadId) as { record_json: string } | undefined;
  return row ? JSON.parse(row.record_json) as DirectoryMove : null;
}

export function saveDirectoryMove(db: LanePilotDatabase, move: DirectoryMove): void {
  db.prepare("INSERT INTO lane_pilot_directory_move(thread_id,operation_id,record_json) VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET operation_id=excluded.operation_id,record_json=excluded.record_json")
    .run(move.threadId, move.operationId, JSON.stringify(move));
}

export function clearDirectoryMove(db: LanePilotDatabase, threadId: string, operationId: string): void {
  db.prepare("DELETE FROM lane_pilot_directory_move WHERE thread_id=? AND operation_id=?").run(threadId, operationId);
}

export function assertRunAdmission(db: LanePilotDatabase, runId: string): void {
  const run = db.prepare("SELECT closed_at,pm_thread_id FROM lane_pilot_run WHERE id=?").get(runId) as { closed_at: number | null; pm_thread_id: string | null } | undefined;
  if (!run) throw new Error("Lane Pilot admission refused: run does not exist");
  if (run.closed_at !== null) throw new Error("Lane Pilot admission refused: run is closed; use the chat's current run");
  if (run.pm_thread_id && directoryMove(db, run.pm_thread_id)) throw new Error("Lane Pilot directory move is pending; finish or recover the move before admitting work");
}

type Admission = { threadId: string } | { workflowRuns: () => readonly string[] };
type Admissions = { files: Map<string, Set<Admission>>; memory: WeakMap<LanePilotDatabase, Set<Admission>> };
const admissionKey = Symbol.for("lane-pilot.run-admissions");

/** Core loads plugins in-process. Share across reload generations and SQLite connections, but never persist dead callbacks after a crash. */
function admissions(db: LanePilotDatabase): Set<Admission> {
  const processState = globalThis as typeof globalThis & { [admissionKey]?: Admissions };
  const registry = processState[admissionKey] ??= { files: new Map(), memory: new WeakMap() };
  if (!db.name || db.name === ":memory:") {
    let entries = registry.memory.get(db);
    if (!entries) registry.memory.set(db, entries = new Set());
    return entries;
  }
  const path = realpathSync(db.name);
  let entries = registry.files.get(path);
  if (!entries) registry.files.set(path, entries = new Set());
  return entries;
}

export function hasRunAdmission(db: LanePilotDatabase, threadId: string): boolean {
  return [...admissions(db)].some((entry) => "threadId" in entry ? entry.threadId === threadId
    : entry.workflowRuns().some((runId) => {
      const linked = wfRunRow(db, runId)?.link_run_id;
      return linked ? getRun(db, linked)?.pm_thread_id === threadId : false;
    }));
}

/** A canceled drive can still be settling its async executor. Keep old plugin generations visible until they finish. */
export function trackWorkflowAdmissions(db: LanePilotDatabase, workflowRuns: () => readonly string[]): () => void {
  const entries = admissions(db), entry = { workflowRuns };
  entries.add(entry);
  return () => { entries.delete(entry); };
}

export function beginRunAdmission(db: LanePilotDatabase, runId: string): () => void {
  assertRunAdmission(db, runId);
  const run = db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE id=?").get(runId) as { pm_thread_id: string | null };
  const entries = admissions(db), entry = { threadId: run.pm_thread_id ?? "" };
  entries.add(entry);
  // Releasing does not touch the database: a draining generation can finish even after its connection closes.
  return () => { entries.delete(entry); };
}
