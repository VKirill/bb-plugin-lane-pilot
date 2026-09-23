import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { PrototypeConfig } from "./contracts";
import { parseDirtSnapshots, type DirtSnapshot } from "./cli-outcome";
import { validateSettingsObject, validationErrorText, type SettingValidationError } from "./setting-validation";

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
  `ALTER TABLE lane_pilot_run ADD COLUMN closed_at INTEGER`,
  `CREATE TABLE lane_pilot_run_next (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    pm_thread_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending','running','accepted','blocked','closed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'bb',
    closed_at INTEGER,
    closed_by TEXT
  )`,
  `INSERT INTO lane_pilot_run_next (id,project_id,pm_thread_id,state,created_at,updated_at,kind,closed_at,closed_by)
    SELECT id,project_id,pm_thread_id,
      CASE WHEN closed_at IS NULL THEN state ELSE 'closed' END,
      created_at,updated_at,kind,closed_at,
      CASE WHEN closed_at IS NULL THEN NULL ELSE 'legacy' END
    FROM lane_pilot_run`,
  `CREATE TABLE lane_pilot_task_next (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('bb','cli')),
    contract_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES lane_pilot_run_next(id)
  )`,
  `INSERT INTO lane_pilot_task_next (id,run_id,kind,contract_json,created_at)
    SELECT id,run_id,kind,contract_json,created_at FROM lane_pilot_task`,
  `CREATE TABLE lane_pilot_attempt_next (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    thread_id TEXT,
    state TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    attempt_no INTEGER NOT NULL DEFAULT 1,
    dirt_before_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE(run_id,task_id,id),
    FOREIGN KEY(run_id) REFERENCES lane_pilot_run_next(id)
  )`,
  `INSERT INTO lane_pilot_attempt_next (id,run_id,task_id,thread_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json)
    SELECT id,run_id,task_id,thread_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json FROM lane_pilot_attempt`,
  `DROP TABLE lane_pilot_attempt`,
  `DROP TABLE lane_pilot_task`,
  `DROP TABLE lane_pilot_run`,
  `ALTER TABLE lane_pilot_run_next RENAME TO lane_pilot_run`,
  `ALTER TABLE lane_pilot_task_next RENAME TO lane_pilot_task`,
  `ALTER TABLE lane_pilot_attempt_next RENAME TO lane_pilot_attempt`,
  `ALTER TABLE lane_pilot_run ADD COLUMN writer_workspace_path TEXT`,
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

export function createRun(db: LanePilotDatabase, id: string, projectId: string, kind: "bb"|"cli" = "bb", writerWorkspacePath: string | null = null): void {
  const now = Date.now();
  db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,kind,created_at,updated_at,writer_workspace_path) VALUES (?,?,\'pending\',?,?,?,?)")
    .run(id, projectId, kind, now, now, writerWorkspacePath);
}

export function setRunState(db: LanePilotDatabase, runId: string, state: string): void {
  db.prepare("UPDATE lane_pilot_run SET state=?, updated_at=? WHERE id=?").run(state, Date.now(), runId);
}

export function closeRun(db: LanePilotDatabase, runId: string, closedBy: "rpc" | "cli"): boolean {
  return db.transaction(() => {
    const run = db.prepare("SELECT state,closed_at FROM lane_pilot_run WHERE id=?").get(runId) as
      {state:string;closed_at:number|null}|undefined;
    if (!run) throw new Error("run does not exist");
    if (run.closed_at) return true;
    const open = db.prepare("SELECT 1 FROM lane_pilot_attempt WHERE run_id=? AND state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested') LIMIT 1").get(runId);
    if (open) return false;
    const now = Date.now();
    db.prepare("UPDATE lane_pilot_run SET state='closed',closed_at=?,closed_by=?,updated_at=? WHERE id=? AND closed_at IS NULL")
      .run(now, closedBy, now, runId);
    return true;
  }).immediate();
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

export function releaseActivation(db: LanePilotDatabase, projectId: string, runId?: string): void {
  if (runId) db.prepare("DELETE FROM lane_pilot_activation WHERE project_id=? AND run_id=?").run(projectId, runId);
  else db.prepare("DELETE FROM lane_pilot_activation WHERE project_id=?").run(projectId);
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
  id:string; run_id:string; task_id:string; thread_id:string|null; state:string; attempt_no:number; dirt_before:DirtSnapshot[];
}|undefined {
  const row = db.prepare("SELECT id,run_id,task_id,thread_id,state,attempt_no,dirt_before_json FROM lane_pilot_attempt WHERE id=?").get(attemptId) as
    {id:string; run_id:string; task_id:string; thread_id:string|null; state:string; attempt_no:number; dirt_before_json?:string}|undefined;
  if (!row) return undefined;
  const dirt_before = parseDirtSnapshots(row.dirt_before_json ?? "[]");
  return { id:row.id, run_id:row.run_id, task_id:row.task_id, thread_id:row.thread_id, state:row.state, attempt_no:row.attempt_no, dirt_before };
}

export function setAttemptDirtBefore(db: LanePilotDatabase, attemptId: string, files: DirtSnapshot[] | string[]): void {
  db.prepare("UPDATE lane_pilot_attempt SET dirt_before_json=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(files), Date.now(), attemptId);
}

export function listSettingRows(db: LanePilotDatabase, projectId: string): Array<{
  key:string; value:unknown; version:number; updated_at:number;
}> {
  return (db.prepare(`SELECT key,value,version,updated_at FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id=''`).all(projectId) as Array<{
    key:string; value:string; version:number; updated_at:number;
  }>).map((row) => {
    let value: unknown = row.value;
    try { value = JSON.parse(row.value); } catch { /* keep text */ }
    return { key:row.key, value, version:row.version, updated_at:row.updated_at };
  });
}

export function casUpsertSetting(
  db: LanePilotDatabase,
  args: { projectId:string; key:string; value:unknown; expectedVersion:number },
): { ok:true; version:number } | { ok:false; conflict:true; version:number; value:unknown }
  | { ok:false; conflict:false; version:number; value:unknown; validation:SettingValidationError } {
  const current = db.prepare(`SELECT value,version FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id='' AND key=?`).get(args.projectId, args.key) as
    {value:string; version:number}|undefined;
  if ((args.expectedVersion === 0 && current) || (args.expectedVersion > 0 && (!current || current.version !== args.expectedVersion))) {
    let value: unknown = current?.value ?? null;
    if (current) {
      try { value = JSON.parse(current.value); } catch { /* keep stored text */ }
    }
    return { ok:false, conflict:true, version:current?.version ?? 0, value };
  }
  const projectRows = db.prepare(`SELECT key,value FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id=''`).all(args.projectId) as Array<{key:string; value:string}>;
  const settings: Record<string, unknown> = {};
  for (const row of projectRows) {
    try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; }
  }
  settings[args.key] = args.value;
  const validation = validateSettingsObject(settings)[0];
  if (validation) {
    let value: unknown = current?.value ?? null;
    if (current) {
      try { value = JSON.parse(current.value); } catch { /* keep stored text */ }
    }
    return { ok:false, conflict:false, version:current?.version ?? 0, value, validation };
  }
  if (args.expectedVersion === 0) {
    if (current) {
      let value: unknown = current.value;
      try { value = JSON.parse(current.value); } catch { /* keep */ }
      return { ok:false, conflict:true, version:current.version, value };
    }
    db.prepare(`INSERT INTO lane_pilot_project_settings
      (project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,1,?)`)
      .run(args.projectId, "", args.key, JSON.stringify(args.value), Date.now());
    return { ok:true, version:1 };
  }
  if (!casSetting(db, args)) {
    if (!current) return { ok:false, conflict:true, version:0, value:null };
    let value: unknown = current.value;
    try { value = JSON.parse(current.value); } catch { /* keep */ }
    return { ok:false, conflict:true, version:current.version, value };
  }
  const next = db.prepare(`SELECT version FROM lane_pilot_project_settings
    WHERE project_id=? AND binding_id='' AND key=?`).get(args.projectId, args.key) as {version:number};
  return { ok:true, version:next.version };
}

export type SettingChange = { key:string; value:unknown; expectedVersion:number };
export type SaveSettingsResult = {
  ok:boolean;
  conflict:boolean;
  values:Record<string, unknown>;
  versions:Record<string, number>;
  validation?:SettingValidationError;
};

/** Compare, validate and persist a dependent setting group as one SQLite transaction. */
export function casUpsertSettings(
  db: LanePilotDatabase,
  args: { projectId:string; changes:SettingChange[] },
): SaveSettingsResult {
  const save = db.transaction((): SaveSettingsResult => {
    const keys = args.changes.map((change) => change.key);
    if (new Set(keys).size !== keys.length) {
      throw new Error("save_settings changes must contain unique keys");
    }
    const rows = db.prepare(`SELECT key,value,version FROM lane_pilot_project_settings
      WHERE project_id=? AND binding_id=''`).all(args.projectId) as Array<{
        key:string; value:string; version:number;
      }>;
    const settings: Record<string, unknown> = {};
    const stored = new Map<string, { value:unknown; version:number }>();
    for (const row of rows) {
      let value: unknown = row.value;
      try { value = JSON.parse(row.value); } catch { /* keep stored text */ }
      settings[row.key] = value;
      stored.set(row.key, { value, version:row.version });
    }
    const snapshot = () => {
      const values: Record<string, unknown> = {};
      const versions: Record<string, number> = {};
      for (const key of keys) {
        values[key] = stored.get(key)?.value ?? null;
        versions[key] = stored.get(key)?.version ?? 0;
      }
      return { values, versions };
    };
    if (args.changes.some((change) => (stored.get(change.key)?.version ?? 0) !== change.expectedVersion)) {
      return { ok:false, conflict:true, ...snapshot() };
    }
    for (const change of args.changes) settings[change.key] = change.value;
    const validation = validateSettingsObject(settings)[0];
    if (validation) return { ok:false, conflict:false, ...snapshot(), validation };

    const now = Date.now();
    const insert = db.prepare(`INSERT INTO lane_pilot_project_settings
      (project_id,binding_id,key,value,version,updated_at) VALUES (?, '', ?, ?, 1, ?)`);
    const update = db.prepare(`UPDATE lane_pilot_project_settings SET value=?, version=version+1, updated_at=?
      WHERE project_id=? AND binding_id='' AND key=? AND version=?`);
    const values: Record<string, unknown> = {};
    const versions: Record<string, number> = {};
    for (const change of args.changes) {
      if (change.expectedVersion === 0) {
        insert.run(args.projectId, change.key, JSON.stringify(change.value), now);
        versions[change.key] = 1;
      } else {
        const result = update.run(JSON.stringify(change.value), now, args.projectId, change.key, change.expectedVersion);
        if (result.changes !== 1) throw new Error(`save_settings CAS changed during transaction: ${change.key}`);
        versions[change.key] = change.expectedVersion + 1;
      }
      values[change.key] = change.value;
    }
    return { ok:true, conflict:false, values, versions };
  });
  return save.immediate();
}

export function listRunsWithAttempts(db: LanePilotDatabase, projectId: string): Array<{
  id:string; state:string; kind:string; created_at:number; updated_at:number; closed_at:number|null; pm_thread_id:string|null;
  attempts: Array<{
    id:string; state:string; attempt_no:number; thread_id:string|null; reason:string|null; task_id:string;
  }>;
}> {
  const runs = db.prepare(`SELECT id,state,kind,created_at,updated_at,closed_at,pm_thread_id FROM lane_pilot_run
    WHERE project_id=? ORDER BY created_at DESC`).all(projectId) as Array<{
    id:string; state:string; kind:string; created_at:number; updated_at:number; closed_at:number|null; pm_thread_id:string|null;
  }>;
  return runs.map((run) => ({
    ...run,
    attempts: db.prepare(`SELECT id,state,attempt_no,thread_id,reason,task_id FROM lane_pilot_attempt
      WHERE run_id=? ORDER BY attempt_no`).all(run.id) as Array<{
      id:string; state:string; attempt_no:number; thread_id:string|null; reason:string|null; task_id:string;
    }>,
  }));
}

export function getRun(db: LanePilotDatabase, runId: string): {
  id:string; project_id:string; pm_thread_id:string|null; state:string; kind:string; closed_at:number|null; writer_workspace_path:string|null;
}|undefined {
  return db.prepare("SELECT id,project_id,pm_thread_id,state,kind,closed_at,writer_workspace_path FROM lane_pilot_run WHERE id=?").get(runId) as
    {id:string; project_id:string; pm_thread_id:string|null; state:string; kind:string; closed_at:number|null; writer_workspace_path:string|null}|undefined;
}
