import { realpathSync } from "node:fs";
import type { LanePilotDatabase } from "./database";

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

export function assertRunAdmission(db: LanePilotDatabase, runId: string): void {
  const run = db.prepare("SELECT closed_at,pm_thread_id FROM lane_pilot_run WHERE id=?").get(runId) as { closed_at: number | null; pm_thread_id: string | null } | undefined;
  if (!run) throw new Error("Lane Pilot admission refused: run does not exist");
  if (run.closed_at !== null) throw new Error("Lane Pilot admission refused: run is closed; use the chat's current run");
  if (run.pm_thread_id && directoryMove(db, run.pm_thread_id)) throw new Error("Lane Pilot directory move is pending; finish or recover the move before admitting work");
}

type Admission = { threadId: string };
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
  return [...admissions(db)].some((entry) => entry.threadId === threadId);
}

export function beginRunAdmission(db: LanePilotDatabase, runId: string): () => void {
  assertRunAdmission(db, runId);
  const run = db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE id=?").get(runId) as { pm_thread_id: string | null };
  const entries = admissions(db), entry = { threadId: run.pm_thread_id ?? "" };
  entries.add(entry);
  // Releasing does not touch the database: a draining generation can finish even after its connection closes.
  return () => { entries.delete(entry); };
}
