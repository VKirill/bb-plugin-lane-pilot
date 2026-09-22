import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { PrototypeConfig } from "./contracts";

export type LanePilotDatabase = Database.Database;

export const migrations = [
  `CREATE TABLE lane_pilot_project_settings (
    project_id TEXT NOT NULL,
    binding_id TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, binding_id, key)
  ) WITHOUT ROWID`,
  `CREATE TABLE lane_pilot_run (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    pm_thread_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending','running','accepted','blocked')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE lane_pilot_attempt (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    thread_id TEXT,
    state TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(run_id, task_id, id),
    FOREIGN KEY(run_id) REFERENCES lane_pilot_run(id)
  )`,
];

export function openDatabase(bb: BbPluginApi): LanePilotDatabase {
  const db = bb.storage.database();
  db.pragma("foreign_keys = ON");
  bb.storage.migrate(db, migrations);
  return db;
}

const CONFIG_KEYS = [
  "hostId", "pmWorkspacePath", "writerWorkspacePath", "pmProviderId",
  "pmModel", "writerProviderId", "writerModel",
] as const;

export function savePrototypeConfig(db: LanePilotDatabase, config: PrototypeConfig): void {
  const now = Date.now();
  const statement = db.prepare(`INSERT INTO lane_pilot_project_settings
    (project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,1,?)
    ON CONFLICT(project_id,binding_id,key) DO UPDATE SET
      value=excluded.value, version=lane_pilot_project_settings.version+1, updated_at=excluded.updated_at`);
  db.transaction(() => {
    for (const key of CONFIG_KEYS) statement.run(config.projectId, "", key, JSON.stringify(config[key]), now);
  })();
}

export function loadPrototypeConfig(db: LanePilotDatabase, projectId: string): PrototypeConfig | null {
  const rows = db.prepare(`SELECT key,value FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id=''`).all(projectId) as Array<{key:string; value:string}>;
  const values = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
  if (!CONFIG_KEYS.every((key) => typeof values[key] === "string" && values[key].length > 0)) return null;
  return { projectId, ...(values as Omit<PrototypeConfig, "projectId">) };
}

export function casSetting(
  db: LanePilotDatabase,
  args: { projectId: string; bindingId?: string; key: string; value: unknown; expectedVersion: number },
): boolean {
  const result = db.prepare(`UPDATE lane_pilot_project_settings
    SET value=?, version=version+1, updated_at=?
    WHERE project_id=? AND binding_id=? AND key=? AND version=?`).run(
      JSON.stringify(args.value), Date.now(), args.projectId, args.bindingId ?? "", args.key, args.expectedVersion,
    );
  return result.changes === 1;
}

export function createRun(db: LanePilotDatabase, id: string, projectId: string): void {
  const now = Date.now();
  db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,created_at,updated_at) VALUES (?,?,\'pending\',?,?)")
    .run(id, projectId, now, now);
}

export function setRunThread(db: LanePilotDatabase, runId: string, threadId: string): void {
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=?, state=\'running\', updated_at=? WHERE id=?")
    .run(threadId, Date.now(), runId);
}

export function createAttempt(db: LanePilotDatabase, ids: { id:string; runId:string; taskId:string }): void {
  const now = Date.now();
  db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,created_at,updated_at) VALUES (?,?,?,\'queued\',?,?)")
    .run(ids.id, ids.runId, ids.taskId, now, now);
}

export function transitionAttempt(
  db: LanePilotDatabase,
  attemptId: string,
  state: string,
  fields: { threadId?: string; reason?: string } = {},
): void {
  db.prepare(`UPDATE lane_pilot_attempt SET state=?, thread_id=COALESCE(?,thread_id), reason=?, updated_at=? WHERE id=?`)
    .run(state, fields.threadId ?? null, fields.reason ?? null, Date.now(), attemptId);
}

export function inspectState(db: LanePilotDatabase, projectId: string): Record<string,unknown> {
  const runs = db.prepare("SELECT * FROM lane_pilot_run WHERE project_id=? ORDER BY created_at").all(projectId);
  const attempts = db.prepare(`SELECT a.* FROM lane_pilot_attempt a
    JOIN lane_pilot_run r ON r.id=a.run_id WHERE r.project_id=? ORDER BY a.created_at`).all(projectId);
  const settings = db.prepare(`SELECT project_id,binding_id,key,version,updated_at
    FROM lane_pilot_project_settings WHERE project_id=? ORDER BY binding_id,key`).all(projectId);
  return { projectId, settings, runs, attempts };
}

export function getAttempt(db: LanePilotDatabase, attemptId: string): {id:string; thread_id:string|null; state:string}|undefined {
  return db.prepare("SELECT id,thread_id,state FROM lane_pilot_attempt WHERE id=?").get(attemptId) as
    {id:string; thread_id:string|null; state:string}|undefined;
}
