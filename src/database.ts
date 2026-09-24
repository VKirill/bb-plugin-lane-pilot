import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { PrototypeConfig } from "./contracts";
import type { StageId, StageState } from "./stages/contract";
import { parseDirtSnapshots, type DirtSnapshot } from "./cli-outcome";
import { validateSettingValue, validateSettingsObject, validationErrorText, type SettingValidationError } from "./setting-validation";
import { memoryRecordId, type MemoryCandidate, type MemoryKind, type MemoryRecord, type MemorySearchEngine } from "./stages/memory";

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
  `CREATE TABLE lane_pilot_attempt_reasoning (
    attempt_id TEXT PRIMARY KEY,
    trace_json TEXT NOT NULL,
    FOREIGN KEY(attempt_id) REFERENCES lane_pilot_attempt(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,
  `CREATE TABLE lane_pilot_task_plan (
    task_id TEXT PRIMARY KEY,
    plan TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES lane_pilot_task(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,
  `CREATE TABLE lane_pilot_stage_receipt (
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    contract_version INTEGER NOT NULL CHECK(contract_version = 1),
    state TEXT NOT NULL CHECK(state IN ('pending','running','passed','failed','blocked','skipped','canceled')),
    input_sha256 TEXT NOT NULL,
    output_sha256 TEXT,
    attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 2),
    provider_id TEXT,
    model TEXT,
    thread_id TEXT,
    result_json TEXT,
    reason TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, task_id, stage_id),
    FOREIGN KEY(run_id) REFERENCES lane_pilot_run(id) ON DELETE CASCADE,
    FOREIGN KEY(task_id) REFERENCES lane_pilot_task(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,
  `CREATE TABLE lane_pilot_memory (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('core','note')),
    audience TEXT NOT NULL CHECK(audience IN ('owner','subagent','export')),
    content TEXT NOT NULL,
    concepts_json TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(project_id,id)
  )`,
  `CREATE VIRTUAL TABLE lane_pilot_memory_fts USING fts5(id UNINDEXED, project_id UNINDEXED, content, concepts)`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN workspace_path TEXT`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN environment_id TEXT`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN workspace_decision_json TEXT`,
  `CREATE TABLE lane_pilot_stage_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','running','passed','failed','blocked','skipped','canceled')),
    input_sha256 TEXT NOT NULL,
    output_sha256 TEXT,
    attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 2),
    occurred_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_stage_event_project_time ON lane_pilot_stage_event(project_id, occurred_at DESC)`,
  `CREATE TRIGGER lane_pilot_stage_event_no_update BEFORE UPDATE ON lane_pilot_stage_event BEGIN SELECT RAISE(ABORT, 'stage events are append-only'); END`,
  `CREATE TRIGGER lane_pilot_stage_event_no_delete BEFORE DELETE ON lane_pilot_stage_event BEGIN SELECT RAISE(ABORT, 'stage events are append-only'); END`,
  `CREATE TABLE lane_pilot_gate_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    gate TEXT NOT NULL CHECK(gate IN ('owns-paths','validate','accept','verification')),
    status TEXT NOT NULL CHECK(status IN ('passed','rejected','failed','skipped')),
    input_sha256 TEXT NOT NULL,
    output_sha256 TEXT,
    attempt INTEGER NOT NULL CHECK(attempt BETWEEN 0 AND 2),
    occurred_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_gate_event_project_time ON lane_pilot_gate_event(project_id, occurred_at DESC)`,
  `CREATE TRIGGER lane_pilot_gate_event_no_update BEFORE UPDATE ON lane_pilot_gate_event BEGIN SELECT RAISE(ABORT, 'gate events are append-only'); END`,
  `CREATE TRIGGER lane_pilot_gate_event_no_delete BEFORE DELETE ON lane_pilot_gate_event BEGIN SELECT RAISE(ABORT, 'gate events are append-only'); END`,
  `CREATE TABLE lane_pilot_task_git_base (
    task_id TEXT PRIMARY KEY REFERENCES lane_pilot_task(id),
    base_ref TEXT,
    base_sha TEXT,
    initial_head_sha TEXT NOT NULL,
    branch TEXT NOT NULL,
    compare_committed INTEGER NOT NULL CHECK(compare_committed IN (0,1)),
    captured_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
  `ALTER TABLE lane_pilot_run ADD COLUMN run_policy_json TEXT NOT NULL DEFAULT '{"schemaVersion":1,"pools":{"provider":5,"verification":2}}'`,
  `ALTER TABLE lane_pilot_memory ADD COLUMN personal_bot TEXT NOT NULL DEFAULT ''`,
  `CREATE INDEX lane_pilot_memory_project_bot_audience ON lane_pilot_memory(project_id,personal_bot,audience)`,
  `ALTER TABLE lane_pilot_run ADD COLUMN writer_environment_id TEXT`,
  `ALTER TABLE lane_pilot_run ADD COLUMN run_gate TEXT NOT NULL DEFAULT 'none' CHECK(run_gate IN ('none','pre-merge'))`,
  `ALTER TABLE lane_pilot_attempt ADD COLUMN holder_thread_id TEXT`,
  `ALTER TABLE lane_pilot_run ADD COLUMN writer_host_id TEXT`,
];

export function openDatabase(bb: BbPluginApi): LanePilotDatabase {
  const db = bb.storage.database();
  db.pragma("foreign_keys = ON");
  bb.storage.migrate(db, migrations);
  return db;
}

export function storeMemoryRecords(db:LanePilotDatabase,input:{projectId:string;personalBot?:string;audience:"owner"|"subagent"|"export";sourceSha256:string;entries:MemoryCandidate[];coreBudget:number;noteBudget:number;indexBudget:number}):{records:MemoryRecord[];insertedIds:string[]} {
  return db.transaction(()=>{
    const personalBot=input.personalBot??"";
    const existing=db.prepare("SELECT kind,content FROM lane_pilot_memory WHERE project_id=? AND personal_bot=?").all(input.projectId,personalBot) as Array<{kind:MemoryKind;content:string}>;
    const ids=new Set(existing.map((row)=>memoryRecordId(input.projectId,row.kind,row.content,personalBot)));
    const pending=input.entries.filter((entry)=>!ids.has(memoryRecordId(input.projectId,entry.kind,entry.content,personalBot)));
    const estimate=(text:string)=>Math.ceil(Buffer.byteLength(text,"utf8")/4);
    const core=existing.filter((row)=>row.kind==="core").reduce((sum,row)=>sum+estimate(row.content),0)+pending.filter((row)=>row.kind==="core").reduce((sum,row)=>sum+estimate(row.content),0);
    const note=existing.filter((row)=>row.kind==="note").reduce((sum,row)=>sum+estimate(row.content),0)+pending.filter((row)=>row.kind==="note").reduce((sum,row)=>sum+estimate(row.content),0);
    const total=core+note;
    if(core>input.coreBudget)throw new Error(`memory core budget exceeded: ${core}/${input.coreBudget} tokens`);
    if(note>input.noteBudget)throw new Error(`memory note budget exceeded: ${note}/${input.noteBudget} tokens`);
    if(total>input.indexBudget)throw new Error(`memory index budget exceeded: ${total}/${input.indexBudget} tokens`);
    const insert=db.prepare(`INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at)
      VALUES(@id,@projectId,@personalBot,@kind,@audience,@content,@conceptsJson,@sourceSha256,@createdAt)
      ON CONFLICT(project_id,id) DO NOTHING`);
    const fts=db.prepare("INSERT INTO lane_pilot_memory_fts(id,project_id,content,concepts) VALUES(?,?,?,?)");
    const now=Date.now();
    const insertedIds:string[]=[];
    for(const entry of pending){
      const id=memoryRecordId(input.projectId,entry.kind,entry.content,personalBot);
      const conceptsJson=JSON.stringify(entry.concepts);
      insert.run({id,projectId:input.projectId,personalBot,kind:entry.kind,audience:input.audience,content:entry.content,conceptsJson,sourceSha256:input.sourceSha256,createdAt:now});
      fts.run(id,input.projectId,entry.content,entry.concepts.join(" "));
      insertedIds.push(id);
    }
    const records=(db.prepare("SELECT id,project_id AS projectId,personal_bot AS personalBot,kind,audience,content,concepts_json AS conceptsJson,source_sha256 AS sourceSha256,created_at AS createdAt FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? ORDER BY created_at DESC").all(input.projectId,personalBot) as Array<{id:string;projectId:string;personalBot:string;kind:MemoryKind;audience:string;content:string;conceptsJson:string;sourceSha256:string;createdAt:number}>).map((row)=>({id:row.id,projectId:row.projectId,personalBot:row.personalBot,kind:row.kind,content:row.content,concepts:JSON.parse(row.conceptsJson) as string[],sourceSha256:row.sourceSha256,createdAt:row.createdAt}));
    return {records,insertedIds};
  }).immediate();
}

export function searchMemoryRecords(db:LanePilotDatabase,projectId:string,query:string,limit:number,engine:MemorySearchEngine,audience:"owner"|"subagent"|"export"="subagent",personalBot=""):MemoryRecord[] {
  const tokens=[...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)??[])].slice(0,32);
  if(tokens.length===0||limit<=0)return [];
  let rows:Array<{id:string;project_id:string;personal_bot:string;kind:MemoryKind;content:string;concepts_json:string;source_sha256:string;created_at:number}>;
  if(engine!=="bm25"){
    const match=tokens.map((word)=>`"${word.replaceAll('"','')}"`).join(" OR ");
    rows=db.prepare(`SELECT m.id,m.project_id,m.personal_bot,m.kind,m.content,m.concepts_json,m.source_sha256,m.created_at
      FROM lane_pilot_memory_fts f JOIN lane_pilot_memory m ON m.id=f.id AND m.project_id=f.project_id
      WHERE lane_pilot_memory_fts MATCH ? AND f.project_id=? AND m.audience=? AND m.personal_bot=?
      ORDER BY bm25(lane_pilot_memory_fts) LIMIT ?`).all(match,projectId,audience,personalBot,limit) as typeof rows;
  } else {
    const all=db.prepare("SELECT id,project_id,personal_bot,kind,content,concepts_json,source_sha256,created_at FROM lane_pilot_memory WHERE project_id=? AND audience=? AND personal_bot=?").all(projectId,audience,personalBot) as typeof rows;
    const score=(text:string)=>tokens.reduce((sum,token)=>sum+(text.toLowerCase().split(token).length-1),0);
    rows=all.map((row)=>({...row,_score:score(`${row.content} ${row.concepts_json}`)})).filter((row)=>row._score>0).sort((a,b)=>b._score-a._score||b.created_at-a.created_at).slice(0,limit);
  }
  return rows.map((row)=>({id:row.id,projectId:row.project_id,personalBot:row.personal_bot,kind:row.kind,content:row.content,concepts:JSON.parse(row.concepts_json) as string[],sourceSha256:row.source_sha256,createdAt:row.created_at}));
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

/** Atomically claim a project-scoped daily schedule date; duplicate callbacks and plugin reloads are no-ops. */
export function claimDailySchedule(db:LanePilotDatabase, projectId:string, scheduleName:string, localDate:string):boolean {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scheduleName)) throw new Error("invalid schedule name");
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(localDate) ? new Date(`${localDate}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0,10) !== localDate) {
    throw new Error("invalid schedule date");
  }
  const key = `schedule.${scheduleName}.lastRunDate`;
  return db.transaction(() => {
    const current = db.prepare(`SELECT value,version FROM lane_pilot_project_settings
      WHERE project_id=? AND binding_id='' AND key=?`).get(projectId,key) as {value:string;version:number}|undefined;
    const value = JSON.stringify(localDate);
    const now = Date.now();
    if (!current) {
      return db.prepare(`INSERT OR IGNORE INTO lane_pilot_project_settings
        (project_id,binding_id,key,value,version,updated_at) VALUES (?,'',?,?,1,?)`).run(projectId,key,value,now).changes === 1;
    }
    if (current.value === value) return false;
    return db.prepare(`UPDATE lane_pilot_project_settings SET value=?,version=version+1,updated_at=?
      WHERE project_id=? AND binding_id='' AND key=? AND version=? AND value=?`)
      .run(value,now,projectId,key,current.version,current.value).changes === 1;
  }).immediate();
}

export function createRun(db: LanePilotDatabase, id: string, projectId: string, kind: "bb"|"cli" = "bb", writerWorkspacePath: string | null = null, runGate: "none"|"pre-merge" = "none", runPolicy:unknown = {schemaVersion:1,pools:{provider:5,verification:2}}, writerHostId: string | null = null): void {
  const now = Date.now();
  db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,kind,created_at,updated_at,writer_workspace_path,run_gate,run_policy_json,writer_host_id) VALUES (?,?,\'pending\',?,?,?,?,?,?,?)")
    .run(id, projectId, kind, now, now, writerWorkspacePath, runGate, JSON.stringify(runPolicy), writerHostId);
}

export function getRunWriterHost(db: LanePilotDatabase, runId: string): string | null {
  const row = db.prepare("SELECT writer_host_id FROM lane_pilot_run WHERE id=?").get(runId) as {writer_host_id:string|null}|undefined;
  const hostId = row?.writer_host_id?.trim();
  return hostId ? hostId : null;
}

/** Bind a provisioned BB managed worktree once, before the run can dispatch any tasks. */
export function setRunWorkspace(db: LanePilotDatabase, runId: string, workspacePath: string, environmentId: string): boolean {
  const result = db.prepare(`UPDATE lane_pilot_run SET writer_workspace_path=?, writer_environment_id=?, updated_at=?
    WHERE id=? AND state='pending' AND writer_workspace_path IS NULL AND writer_environment_id IS NULL`)
    .run(workspacePath, environmentId, Date.now(), runId);
  return result.changes === 1;
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

export function saveTaskGitBase(db:LanePilotDatabase,taskId:string,base:{baseRef:string|null;baseSha:string|null;initialHeadSha:string;branch:string;compareCommitted:boolean}):boolean {
  if(!/^[a-f0-9]{40,64}$/.test(base.initialHeadSha)||!base.branch||base.branch.length>240
    ||(base.baseSha!==null&&!/^[a-f0-9]{40,64}$/.test(base.baseSha))) return false;
  const changed=db.prepare(`INSERT INTO lane_pilot_task_git_base(task_id,base_ref,base_sha,initial_head_sha,branch,compare_committed,captured_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING`)
    .run(taskId,base.baseRef,base.baseSha,base.initialHeadSha,base.branch,base.compareCommitted?1:0,Date.now()).changes;
  return changed===1;
}

export function getTaskGitBase(db:LanePilotDatabase,taskId:string):{base_ref:string|null;base_sha:string|null;initial_head_sha:string;branch:string;compare_committed:boolean}|undefined {
  const row=db.prepare("SELECT base_ref,base_sha,initial_head_sha,branch,compare_committed FROM lane_pilot_task_git_base WHERE task_id=?").get(taskId) as
    {base_ref:string|null;base_sha:string|null;initial_head_sha:string;branch:string;compare_committed:number}|undefined;
  return row?{...row,compare_committed:row.compare_committed===1}:undefined;
}

export function listTasksForRun(db:LanePilotDatabase, runId:string):Array<{
  id:string; run_id:string; kind:"bb"|"cli"; contract:unknown;
}> {
  const rows = db.prepare("SELECT id,run_id,kind,contract_json FROM lane_pilot_task WHERE run_id=? ORDER BY id")
    .all(runId) as Array<{id:string;run_id:string;kind:"bb"|"cli";contract_json:string}>;
  return rows.map((row) => ({ id:row.id, run_id:row.run_id, kind:row.kind, contract:JSON.parse(row.contract_json) }));
}

export function saveTaskPlan(db: LanePilotDatabase, taskId:string, plan:string): void {
  db.prepare(`INSERT INTO lane_pilot_task_plan(task_id,plan) VALUES(?,?)
    ON CONFLICT(task_id) DO UPDATE SET plan=excluded.plan`).run(taskId, plan);
}

export function getTaskPlan(db: LanePilotDatabase, taskId:string): string|null {
  const row = db.prepare("SELECT plan FROM lane_pilot_task_plan WHERE task_id=?").get(taskId) as {plan:string}|undefined;
  return row?.plan ?? null;
}

export type StageReceiptRow = {
  runId:string; taskId:string; stageId:StageId; contractVersion:1;
  state:StageState;
  inputSha256:string; outputSha256:string|null; attempt:number;
  providerId:string|null; model:string|null; threadId:string|null;
  result:unknown|null; reason:string|null; updatedAt:number;
};

/** One caller may spawn the child; others observe. Crash after this flag is reconcile-only. */
export function claimStageSpawn(db: LanePilotDatabase, runId:string, taskId:string, stageId:StageId): boolean {
  return db.transaction(() => {
    const row = db.prepare(`SELECT state,thread_id,result_json FROM lane_pilot_stage_receipt
      WHERE run_id=? AND task_id=? AND stage_id=?`).get(runId, taskId, stageId) as
      {state:StageState;thread_id:string|null;result_json:string|null}|undefined;
    if (!row || row.state !== "running" || row.thread_id) return false;
    let result: Record<string, unknown> = {};
    if (row.result_json) {
      const parsed = JSON.parse(row.result_json) as unknown;
      if (parsed && typeof parsed === "object") result = parsed as Record<string, unknown>;
    }
    if (result.spawnAttempted === true) return false;
    const next = JSON.stringify({ ...result, spawnAttempted:true });
    return db.prepare(`UPDATE lane_pilot_stage_receipt SET result_json=?, updated_at=?
      WHERE run_id=? AND task_id=? AND stage_id=? AND state='running' AND thread_id IS NULL
        AND (result_json IS NULL OR json_extract(result_json,'$.spawnAttempted') IS NOT 1)`)
      .run(next, Date.now(), runId, taskId, stageId).changes === 1;
  }).immediate();
}

export function claimDocsSpawn(db: LanePilotDatabase, runId:string, taskId:string): boolean {
  return claimStageSpawn(db, runId, taskId, "docs-maintenance");
}

export function saveStageReceipt(db: LanePilotDatabase, row:StageReceiptRow): void {
  const { result, ...fields } = row;
  db.transaction(() => {
    const previous = db.prepare("SELECT state,input_sha256,output_sha256,attempt FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id=?")
      .get(row.runId,row.taskId,row.stageId) as {state:StageState;input_sha256:string;output_sha256:string|null;attempt:number}|undefined;
    db.prepare(`INSERT INTO lane_pilot_stage_receipt
    (run_id,task_id,stage_id,contract_version,state,input_sha256,output_sha256,attempt,provider_id,model,thread_id,result_json,reason,updated_at)
    VALUES (@runId,@taskId,@stageId,@contractVersion,@state,@inputSha256,@outputSha256,@attempt,@providerId,@model,@threadId,@resultJson,@reason,@updatedAt)
    ON CONFLICT(run_id,task_id,stage_id) DO UPDATE SET state=excluded.state,
      output_sha256=excluded.output_sha256,attempt=excluded.attempt,provider_id=excluded.provider_id,
      model=excluded.model,thread_id=excluded.thread_id,result_json=excluded.result_json,
      reason=excluded.reason,updated_at=excluded.updated_at`).run({
        ...fields, resultJson:result === null ? null : JSON.stringify(result),
      });
    if (!previous || previous.state !== row.state || previous.input_sha256 !== row.inputSha256 ||
        previous.output_sha256 !== row.outputSha256 || previous.attempt !== row.attempt) {
      const run = db.prepare("SELECT project_id FROM lane_pilot_run WHERE id=?").get(row.runId) as {project_id:string}|undefined;
      if (!run) throw new Error("stage event run is missing");
      db.prepare(`INSERT INTO lane_pilot_stage_event
        (project_id,run_id,task_id,stage_id,state,input_sha256,output_sha256,attempt,occurred_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(run.project_id,row.runId,row.taskId,row.stageId,row.state,
          row.inputSha256,row.outputSha256,row.attempt,row.updatedAt);
    }
  }).immediate();
}

export type StageEventRow = {
  id:number; projectId:string; runId:string; taskId:string; stageId:StageId; state:StageState;
  inputSha256:string; outputSha256:string|null; attempt:number; occurredAt:number;
};

export const GATE_CATEGORIES = ["owns-paths","validate","accept","verification"] as const;
export type GateCategory = (typeof GATE_CATEGORIES)[number];
export type GateEventStatus = "passed"|"rejected"|"failed"|"skipped";
export type GateEventRow = {
  id:number; projectId:string; runId:string; taskId:string; gate:GateCategory; status:GateEventStatus;
  inputSha256:string; outputSha256:string|null; attempt:number; occurredAt:number;
};

export function appendGateEvaluation(db:LanePilotDatabase,row:Omit<GateEventRow,"id">):void {
  db.prepare(`INSERT INTO lane_pilot_gate_event
    (project_id,run_id,task_id,gate,status,input_sha256,output_sha256,attempt,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(row.projectId,row.runId,row.taskId,row.gate,row.status,
      row.inputSha256,row.outputSha256,row.attempt,row.occurredAt);
}

export function listGateEvents(db:LanePilotDatabase,input:{projectId:string;since:number;gate?:GateCategory}):GateEventRow[] {
  const rows=input.gate
    ? db.prepare("SELECT * FROM lane_pilot_gate_event WHERE project_id=? AND occurred_at>=? AND gate=? ORDER BY occurred_at,id").all(input.projectId,input.since,input.gate)
    : db.prepare("SELECT * FROM lane_pilot_gate_event WHERE project_id=? AND occurred_at>=? ORDER BY occurred_at,id").all(input.projectId,input.since);
  return (rows as Array<Record<string,unknown>>).map((row)=>({
    id:row.id as number,projectId:row.project_id as string,runId:row.run_id as string,taskId:row.task_id as string,
    gate:row.gate as GateCategory,status:row.status as GateEventStatus,inputSha256:row.input_sha256 as string,
    outputSha256:row.output_sha256 as string|null,attempt:row.attempt as number,occurredAt:row.occurred_at as number,
  }));
}

export function listStageEvents(db:LanePilotDatabase,input:{projectId:string;since:number;stageId?:StageId}):StageEventRow[] {
  const rows = input.stageId
    ? db.prepare(`SELECT * FROM lane_pilot_stage_event WHERE project_id=? AND occurred_at>=? AND stage_id=? ORDER BY occurred_at,id`)
      .all(input.projectId,input.since,input.stageId)
    : db.prepare(`SELECT * FROM lane_pilot_stage_event WHERE project_id=? AND occurred_at>=? ORDER BY occurred_at,id`)
      .all(input.projectId,input.since);
  return (rows as Array<Record<string,unknown>>).map((row)=>({
    id:row.id as number,projectId:row.project_id as string,runId:row.run_id as string,taskId:row.task_id as string,
    stageId:row.stage_id as StageId,state:row.state as StageState,inputSha256:row.input_sha256 as string,
    outputSha256:row.output_sha256 as string|null,attempt:row.attempt as number,occurredAt:row.occurred_at as number,
  }));
}

export function listStageReceipts(db:LanePilotDatabase, runId:string, taskId?:string): StageReceiptRow[] {
  const rows = taskId
    ? db.prepare("SELECT * FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? ORDER BY stage_id").all(runId, taskId)
    : db.prepare("SELECT * FROM lane_pilot_stage_receipt WHERE run_id=? ORDER BY task_id,stage_id").all(runId);
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    runId:row.run_id as string, taskId:row.task_id as string, stageId:row.stage_id as StageId,
    contractVersion:row.contract_version as 1, state:row.state as StageState,
    inputSha256:row.input_sha256 as string, outputSha256:row.output_sha256 as string|null,
    attempt:row.attempt as number, providerId:row.provider_id as string|null, model:row.model as string|null,
    threadId:row.thread_id as string|null, result:row.result_json == null ? null : JSON.parse(row.result_json as string),
    reason:row.reason as string|null, updatedAt:row.updated_at as number,
  }));
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

/** Bind a task attempt to one immutable writer workspace exactly once. */
export function setAttemptWorkspace(db:LanePilotDatabase, attemptId:string, binding:{path:string;environmentId:string|null;decision:unknown}):boolean {
  if (!binding.path.startsWith("/")) throw new Error("attempt workspace path must be absolute");
  if (binding.environmentId !== null && !binding.environmentId.trim()) throw new Error("attempt environment id must be non-empty or null");
  const decisionJson=JSON.stringify(binding.decision);
  const changed=db.prepare(`UPDATE lane_pilot_attempt SET workspace_path=?,environment_id=?,workspace_decision_json=?,updated_at=?
    WHERE id=? AND state IN ('queued','spawn_requested') AND workspace_path IS NULL AND environment_id IS NULL AND workspace_decision_json IS NULL`)
    .run(binding.path,binding.environmentId,decisionJson,Date.now(),attemptId).changes;
  return changed===1;
}

export function setAttemptHolderThread(db:LanePilotDatabase, attemptId:string, holderThreadId:string):boolean {
  if (!holderThreadId.trim()) throw new Error("holder thread id must be non-empty");
  const changed=db.prepare(`UPDATE lane_pilot_attempt SET holder_thread_id=?,updated_at=?
    WHERE id=? AND holder_thread_id IS NULL AND thread_id IS NULL AND workspace_path IS NULL
    AND state IN ('queued','spawn_requested')`)
    .run(holderThreadId,Date.now(),attemptId).changes;
  return changed===1;
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
  id:string; run_id:string; task_id:string; thread_id:string|null; holder_thread_id:string|null; state:string; attempt_no:number; dirt_before:DirtSnapshot[];
  workspace_path:string|null;environment_id:string|null;workspace_decision:unknown|null;
}|undefined {
  const row = db.prepare("SELECT id,run_id,task_id,thread_id,holder_thread_id,state,attempt_no,dirt_before_json,workspace_path,environment_id,workspace_decision_json FROM lane_pilot_attempt WHERE id=?").get(attemptId) as
    {id:string; run_id:string; task_id:string; thread_id:string|null; holder_thread_id:string|null; state:string; attempt_no:number; dirt_before_json?:string;workspace_path:string|null;environment_id:string|null;workspace_decision_json:string|null}|undefined;
  if (!row) return undefined;
  const dirt_before = parseDirtSnapshots(row.dirt_before_json ?? "[]");
  let workspace_decision:unknown|null=null;
  if(row.workspace_decision_json){try{workspace_decision=JSON.parse(row.workspace_decision_json);}catch{workspace_decision={invalidStoredDecision:true};}}
  return { id:row.id, run_id:row.run_id, task_id:row.task_id, thread_id:row.thread_id, holder_thread_id:row.holder_thread_id, state:row.state, attempt_no:row.attempt_no, dirt_before,
    workspace_path:row.workspace_path,environment_id:row.environment_id,workspace_decision };
}

export type ReasoningTrace = {
  planSha256:string;
  sentPlanSha256:string|null;
  sourceLength:number;
  sentLength:number|null;
  jevStatus:"ok"|"disabled"|"timeout"|"error";
  jevDecision:string|null;
  requestedReasoningLevel:string;
  effectiveReasoningLevel:string;
  retryEffort?:{enabled:boolean;retryIndex:number;before:string;after:string;changed:boolean};
  fallbackReason:string|null;
  providerId:string;
  model:string;
  serviceTier:"default"|"fast"|null;
  requestedServiceTier:"default"|"fast";
  runId:string;
  attemptId:string;
  threadId:string|null;
};

export function saveReasoningTrace(db: LanePilotDatabase, trace: ReasoningTrace): void {
  db.prepare(`INSERT INTO lane_pilot_attempt_reasoning(attempt_id,trace_json) VALUES(?,?)
    ON CONFLICT(attempt_id) DO UPDATE SET trace_json=excluded.trace_json`).run(trace.attemptId, JSON.stringify(trace));
}

export function setReasoningThread(db: LanePilotDatabase, attemptId:string, threadId:string): void {
  const trace = getReasoningTrace(db, attemptId);
  if (trace) saveReasoningTrace(db, { ...trace, threadId });
}

export function getReasoningTrace(db: LanePilotDatabase, attemptId: string): ReasoningTrace|null {
  const row = db.prepare("SELECT trace_json FROM lane_pilot_attempt_reasoning WHERE attempt_id=?").get(attemptId) as {trace_json:string}|undefined;
  if (!row) return null;
  try { return JSON.parse(row.trace_json) as ReasoningTrace; } catch { return null; }
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
  options: { nativeWriterSelection?:boolean } = {},
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
    const nativeWriterKeys = new Set(["writer.provider", "writer.model", "writer.reasoning_effort", "writer.service_tier"]);
    const validation = (options.nativeWriterSelection
      ? Object.entries(settings).flatMap(([key, value]) => nativeWriterKeys.has(key) ? [] : [validateSettingValue(key, value)]).filter((item) => item != null)
      : validateSettingsObject(settings))[0];
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
  id:string; project_id:string; pm_thread_id:string|null; state:string; kind:string; closed_at:number|null; writer_workspace_path:string|null; writer_environment_id:string|null; run_gate:"none"|"pre-merge";run_policy_json:string;
}|undefined {
  return db.prepare("SELECT id,project_id,pm_thread_id,state,kind,closed_at,writer_workspace_path,writer_environment_id,run_gate,run_policy_json FROM lane_pilot_run WHERE id=?").get(runId) as
    {id:string; project_id:string; pm_thread_id:string|null; state:string; kind:string; closed_at:number|null; writer_workspace_path:string|null; writer_environment_id:string|null; run_gate:"none"|"pre-merge";run_policy_json:string}|undefined;
}
