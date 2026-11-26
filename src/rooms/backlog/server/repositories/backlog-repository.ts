import type Database from "better-sqlite3";
import { SETTING_BACKLOG_SCAN_MINUTES } from "@lane-pilot/settings-catalog";
import { loadProjectSettings } from "../../../storage";

type Db = Pick<Database.Database, "prepare">;
type Kv = { get(key: string): Promise<unknown>; set(key: string, value: number): Promise<unknown> };

/** The last time a project's todos were scanned (SMA m_in_cadence): the tick wakes every five minutes, the interval is the owner's setting. */
const lastScanKey = (projectId: string) => `backlog:last-scan:${projectId}`;

/** The project's scan interval in minutes — the person's setting (backlog.scan_minutes), 60 by default. */
export function scanMinutesOf(db: Parameters<typeof loadProjectSettings>[0], projectId: string): number {
  const raw = loadProjectSettings(db, projectId)[SETTING_BACKLOG_SCAN_MINUTES];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 60;
}

/** The PM thread a backlog item was handed to, or undefined when it was never issued: only that thread closes the item. */
export function backlogIssuedTo(db: Db, projectId: string, todoId: string): string | undefined {
  return (db.prepare("SELECT pm_thread_id FROM lane_pilot_backlog_issue WHERE project_id=? AND todo_id=?").get(projectId, todoId) as { pm_thread_id: string } | undefined)?.pm_thread_id;
}

export function listIssuedTodoIds(db: Db, projectId: string): Set<string> {
  return new Set((db.prepare("SELECT todo_id FROM lane_pilot_backlog_issue WHERE project_id=?").all(projectId) as Array<{ todo_id: string }>).map((row) => row.todo_id));
}

export function countIssuedSince(db: Db, since: number): number {
  return (db.prepare("SELECT count(*) AS n FROM lane_pilot_backlog_issue WHERE issued_at>=?").get(since) as { n: number }).n;
}

export function countProjectIssuedSince(db: Db, projectId: string, since: number): number {
  return (db.prepare("SELECT count(*) AS n FROM lane_pilot_backlog_issue WHERE project_id=? AND issued_at>=?").get(projectId, since) as { n: number }).n;
}

export function recordBacklogIssue(db: Db, input: { projectId: string; todoId: string; pmThreadId: string; estimate: number | null; issuedAt: number }): void {
  db.prepare("INSERT OR IGNORE INTO lane_pilot_backlog_issue(project_id,todo_id,pm_thread_id,estimate,issued_at) VALUES (?,?,?,?,?)")
    .run(input.projectId, input.todoId, input.pmThreadId, input.estimate, input.issuedAt);
}

export async function readLastScanAt(kv: Kv, projectId: string): Promise<number | null> {
  const stored = await kv.get(lastScanKey(projectId)).catch(() => null) as number | null;
  return typeof stored === "number" && Number.isFinite(stored) ? stored : null;
}

export async function writeLastScanAt(kv: Kv, projectId: string, now: number): Promise<void> {
  await kv.set(lastScanKey(projectId), now).catch(() => undefined);
}
