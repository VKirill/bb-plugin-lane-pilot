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
  `CREATE TABLE lane_pilot_task (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('bb','cli')),
    contract_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES lane_pilot_run(id)
  )`,
  `CREATE TABLE lane_pilot_activation (
    project_id TEXT PRIMARY KEY,
    pm_thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    claimed_at INTEGER NOT NULL
  )`,
  `ALTER TABLE lane_pilot_run ADD COLUMN kind TEXT NOT NULL DEFAULT 'bb'`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN dirt_before_json TEXT NOT NULL DEFAULT '[]'`,
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

export type ImportedYaml = {
  routingProfile: { path: string; text: string; sha256: string } | null;
  nightShift: { path: string; text: string; sha256: string } | null;
};

export function importSettingsOnce(
  db: LanePilotDatabase,
  projectId: string,
  imported: ImportedYaml,
): { imported: boolean } {
  const existing = db.prepare(`SELECT key FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id='' AND key='import.completed'`).get(projectId);
  if (existing) return { imported: false };
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO lane_pilot_project_settings
    (project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,1,?)`);
  db.transaction(() => {
    insert.run(projectId, "", "import.routing_profile", JSON.stringify(imported.routingProfile), now);
    insert.run(projectId, "", "import.night_shift", JSON.stringify(imported.nightShift), now);
    insert.run(projectId, "", "import.completed", JSON.stringify({ at: now, version: 1 }), now);
  })();
  return { imported: true };
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

export function createRun(db: LanePilotDatabase, id: string, projectId: string, kind: "bb"|"cli" = "bb"): void {
  const now = Date.now();
  db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,kind,created_at,updated_at) VALUES (?,?,\'pending\',?,?,?)")
    .run(id, projectId, kind, now, now);
}

export function setRunState(db: LanePilotDatabase, runId: string, state: string): void {
  db.prepare("UPDATE lane_pilot_run SET state=?, updated_at=? WHERE id=?").run(state, Date.now(), runId);
}

export function createTask(
  db: LanePilotDatabase,
  ids: { id:string; runId:string; kind:"bb"|"cli"; contract:unknown },
): void {
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES (?,?,?,?,?)")
    .run(ids.id, ids.runId, ids.kind, JSON.stringify(ids.contract), Date.now());
}

export function getTask(db: LanePilotDatabase, taskId: string): {
  id:string; run_id:string; kind:"bb"|"cli"; contract:unknown;
}|undefined {
  const row = db.prepare("SELECT id,run_id,kind,contract_json FROM lane_pilot_task WHERE id=?").get(taskId) as
    {id:string; run_id:string; kind:"bb"|"cli"; contract_json:string}|undefined;
  return row ? { id:row.id, run_id:row.run_id, kind:row.kind, contract:JSON.parse(row.contract_json) } : undefined;
}

export function listTaskKinds(db: LanePilotDatabase, runId: string): Array<"bb"|"cli"> {
  return (db.prepare("SELECT kind FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{kind:"bb"|"cli"}>)
    .map((row) => row.kind);
}

export function setRunThread(db: LanePilotDatabase, runId: string, threadId: string): void {
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=?, state=\'running\', updated_at=? WHERE id=?")
    .run(threadId, Date.now(), runId);
}

export function createAttempt(db: LanePilotDatabase, ids: { id:string; runId:string; taskId:string }): void {
  const now = Date.now();
  const used = countAttempts(db, ids.runId, ids.taskId);
  db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,created_at,updated_at) VALUES (?,?,?,\'queued\',?,?,?)")
    .run(ids.id, ids.runId, ids.taskId, used + 1, now, now);
}

export function countAttempts(db: LanePilotDatabase, runId: string, taskId: string): number {
  const row = db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE run_id=? AND task_id=?").get(runId, taskId) as
    {count:number};
  return row.count;
}

export function listAttemptsForTask(db: LanePilotDatabase, runId: string, taskId: string): Array<{
  id:string; state:string; attempt_no:number; thread_id:string|null;
}> {
  return db.prepare("SELECT id,state,attempt_no,thread_id FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY attempt_no")
    .all(runId, taskId) as Array<{id:string; state:string; attempt_no:number; thread_id:string|null}>;
}

export function listTaskTerminalStates(db: LanePilotDatabase, runId: string): string[] {
  const tasks = db.prepare("SELECT id FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{id:string}>;
  return tasks.map((task) => {
    const latest = db.prepare("SELECT state FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY attempt_no DESC LIMIT 1")
      .get(runId, task.id) as {state:string}|undefined;
    return latest?.state ?? "queued";
  });
}

export function listOpenAttempts(db: LanePilotDatabase): Array<{
  id:string; run_id:string; task_id:string; thread_id:string|null; state:string; project_id:string;
}> {
  return db.prepare(`SELECT a.id,a.run_id,a.task_id,a.thread_id,a.state,r.project_id
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE a.state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested')
    ORDER BY a.created_at`).all() as Array<{
    id:string; run_id:string; task_id:string; thread_id:string|null; state:string; project_id:string;
  }>;
}

export function loadProjectSettings(db: LanePilotDatabase, projectId: string): Record<string, unknown> {
  const rows = db.prepare(`SELECT key,value FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id=''`).all(projectId) as Array<{key:string; value:string}>;
  return Object.fromEntries(rows.map((row) => {
    try { return [row.key, JSON.parse(row.value)]; } catch { return [row.key, row.value]; }
  }));
}

export function saveProjectSetting(
  db: LanePilotDatabase,
  projectId: string,
  key: string,
  value: unknown,
): void {
  db.prepare(`INSERT INTO lane_pilot_project_settings
    (project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,1,?)
    ON CONFLICT(project_id,binding_id,key) DO UPDATE SET
      value=excluded.value, version=lane_pilot_project_settings.version+1, updated_at=excluded.updated_at`)
    .run(projectId, "", key, JSON.stringify(value), Date.now());
}

export function claimActivation(
  db: LanePilotDatabase,
  args: { projectId:string; pmThreadId:string; runId:string },
): void {
  const existing = db.prepare("SELECT pm_thread_id,run_id FROM lane_pilot_activation WHERE project_id=?")
    .get(args.projectId) as {pm_thread_id:string; run_id:string}|undefined;
  if (existing && existing.pm_thread_id !== args.pmThreadId) {
    const sameRun = existing.run_id === args.runId;
    const stalePending = existing.pm_thread_id.startsWith("pending:");
    if (!sameRun && !stalePending) {
      const run = getRun(db, existing.run_id);
      if (run && (run.state === "pending" || run.state === "running")) {
        throw new Error(
          `Lane Pilot is already active in this project (thread ${existing.pm_thread_id}). A second activation is blocked.`,
        );
      }
    }
  }
  db.prepare(`INSERT INTO lane_pilot_activation(project_id,pm_thread_id,run_id,claimed_at) VALUES (?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET pm_thread_id=excluded.pm_thread_id, run_id=excluded.run_id, claimed_at=excluded.claimed_at`)
    .run(args.projectId, args.pmThreadId, args.runId, Date.now());
}

export function getActivation(db: LanePilotDatabase, projectId: string): {
  pm_thread_id:string; run_id:string;
}|undefined {
  return db.prepare("SELECT pm_thread_id,run_id FROM lane_pilot_activation WHERE project_id=?").get(projectId) as
    {pm_thread_id:string; run_id:string}|undefined;
}

export function releaseActivation(db: LanePilotDatabase, projectId: string): void {
  db.prepare("DELETE FROM lane_pilot_activation WHERE project_id=?").run(projectId);
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

export function getAttempt(db: LanePilotDatabase, attemptId: string): {
  id:string; run_id:string; task_id:string; thread_id:string|null; state:string; attempt_no:number; dirt_before:import("./cli-outcome").DirtSnapshot[];
}|undefined {
  const row = db.prepare("SELECT id,run_id,task_id,thread_id,state,attempt_no,dirt_before_json FROM lane_pilot_attempt WHERE id=?").get(attemptId) as
    {id:string; run_id:string; task_id:string; thread_id:string|null; state:string; attempt_no:number; dirt_before_json?:string}|undefined;
  if (!row) return undefined;
  const { parseDirtSnapshots } = require("./cli-outcome") as typeof import("./cli-outcome");
  const dirt_before = parseDirtSnapshots(row.dirt_before_json ?? "[]");
  return { id:row.id, run_id:row.run_id, task_id:row.task_id, thread_id:row.thread_id, state:row.state, attempt_no:row.attempt_no, dirt_before };
}

export function setAttemptDirtBefore(db: LanePilotDatabase, attemptId: string, files: import("./cli-outcome").DirtSnapshot[]): void {
  db.prepare("UPDATE lane_pilot_attempt SET dirt_before_json=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(files), Date.now(), attemptId);
}

export function getRun(db: LanePilotDatabase, runId: string): {
  id:string; project_id:string; pm_thread_id:string|null; state:string; kind:string;
}|undefined {
  return db.prepare("SELECT id,project_id,pm_thread_id,state,kind FROM lane_pilot_run WHERE id=?").get(runId) as
    {id:string; project_id:string; pm_thread_id:string|null; state:string; kind:string}|undefined;
}
