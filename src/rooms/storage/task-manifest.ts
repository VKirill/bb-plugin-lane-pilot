import { sha256Hex } from "@lane-pilot/kit";
import packageJson from "../../../package.json";
import type { LanePilotDatabase } from "./database";
import { taskBasePath } from "./tasks-store";

/**
 * One home per task (docs/task-folder.md, SMA n233 «one folder per attempt», n397/n405 «a narrowly granted folder»): every file of a task lives
 * under `<task base checkout>/.agents/tasks/<task-id>/`, and `manifest.json` there lists them. The source of truth is the database
 * (`lane_pilot_task_home`, `lane_pilot_task_file`, `lane_pilot_task_file_read`); the file is its rendering, written by this module only.
 *
 * Nodes hand each other `{task_id, kind}` and read through `resolveTaskFile` / `readTaskFile`: no folder listing, no «newest by mtime», no glob
 * (SMA n132: a name resolves to one address, ambiguity is refused). A task with no home row was dispatched before the switch: it keeps its old
 * layout to the end, and the resolver reads its old files by their fixed names (`legacy`), counting each such read.
 */
export const TASK_MANIFEST_SCHEMA = "lp.task-manifest/1";
export const TASK_HOME_ROOT = ".agents/tasks";
/** The git exclude line of the task homes, like `**\/.agents/plans/items/` before it: one line matches at any depth. */
export const TASK_HOME_EXCLUDE = "**/.agents/tasks/";
export const TASK_MANIFEST_FILE = "manifest.json";

/** The closed list of what a task's file can be. A new kind is added here, in docs/task-folder.md and in the drill's expected set. */
export const TASK_FILE_KINDS = [
  "contract", "plan", "plan-source", "research", "plan-critique", "reflexes", "filecards", "brief", "writer-report", "checks", "check-log",
  "plan-fact", "barrier-input", "code-critique", "qa", "questions", "checkpoint", "progress", "acceptance", "receipt", "outcome", "lesson", "step-input",
] as const;
export type TaskFileKind = (typeof TASK_FILE_KINDS)[number];
export const isTaskFileKind = (value: unknown): value is TaskFileKind => typeof value === "string" && (TASK_FILE_KINDS as readonly string[]).includes(value);

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `.agents/tasks/<id>` for a task id that can be a folder name, else null. */
export function taskHomeRel(taskId: string): string | null {
  return TASK_ID.test(taskId) ? `${TASK_HOME_ROOT}/${taskId}` : null;
}

/** The absolute home of a task under its base checkout. */
export function taskHomeAbs(basePath: string, taskId: string): string | null {
  const rel = taskHomeRel(taskId);
  return rel ? `${basePath.replace(/\/+$/, "")}/${rel}` : null;
}

/** Whether a repository-relative path lies in some task's home (`.agents/tasks/<id>/...`). */
export const isTaskHomePath = (path: string): boolean => /^(?:\.\/)?\.agents\/tasks(?:\/|$)/.test(path.replaceAll("\\", "/"));

/** The task id whose home a repository-relative path is in, or null. */
export function taskHomeOwner(path: string): string | null {
  const match = /^(?:\.\/)?\.agents\/tasks\/([^/]+)/.exec(path.replaceAll("\\", "/"));
  return match && TASK_ID.test(match[1]!) ? match[1]! : null;
}

export type TaskHomeRow = { task_id: string; project_id: string; run_id: string; base_path: string; host_id: string; phase_id: string | null; layout: string; created_at: number };
export type TaskFileRow = {
  task_id: string; path: string; kind: TaskFileKind; attempt_id: string | null; round: number | null; sha256: string; bytes: number;
  producer_json: string; plugin_version: string; readers_json: string; supersedes: string | null; superseded_by: string | null; created_at: number;
};
export type TaskFileProducer = { node: string; graph?: string; stage_id?: string; run_id?: string; attempt_id?: string; wf_step_key?: string };

function tablesReady(db: LanePilotDatabase): boolean {
  try {
    return (db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='lane_pilot_task_file'").get() as { ok?: number } | undefined)?.ok === 1;
  } catch { return false; }
}

/**
 * Opens the home of a task: from now on every file of it goes into `.agents/tasks/<id>/` under `basePath`. Idempotent: the first base stays,
 * a task never moves between two roots.
 */
export function openTaskHome(db: LanePilotDatabase, input: { taskId: string; projectId: string; runId: string; basePath: string; hostId: string; phaseId?: string | null; now?: number }): TaskHomeRow {
  if (!taskHomeRel(input.taskId)) throw new Error(`task id ${input.taskId} cannot name a task home`);
  db.prepare("INSERT OR IGNORE INTO lane_pilot_task_home(task_id,project_id,run_id,base_path,host_id,phase_id,layout,created_at) VALUES(?,?,?,?,?,?,'home',?)")
    .run(input.taskId, input.projectId, input.runId, input.basePath.replace(/\/+$/, ""), input.hostId, input.phaseId ?? null, input.now ?? Date.now());
  return taskHomeOf(db, input.taskId)!;
}

/** The home row of a task, or null for a task on the old layout (dispatched before the switch). */
export function taskHomeOf(db: LanePilotDatabase, taskId: string): TaskHomeRow | null {
  if (!tablesReady(db)) return null;
  return (db.prepare("SELECT * FROM lane_pilot_task_home WHERE task_id=?").get(taskId) as TaskHomeRow | undefined) ?? null;
}

export const hasTaskHome = (db: LanePilotDatabase, taskId: string): boolean => taskHomeOf(db, taskId) !== null;

/** Every file row of a task, in the order they were recorded. */
export function listTaskFiles(db: LanePilotDatabase, taskId: string): TaskFileRow[] {
  if (!tablesReady(db)) return [];
  return db.prepare("SELECT * FROM lane_pilot_task_file WHERE task_id=? ORDER BY created_at, rowid").all(taskId) as TaskFileRow[];
}

function cleanName(name: string): string {
  const rel = name.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!rel || rel.startsWith("/") || rel.split("/").some((part) => part === ".." || part === "") || rel === TASK_MANIFEST_FILE) {
    throw new Error(`«${name}» is not a file name inside a task home`);
  }
  return rel;
}

/**
 * Records one file row (the database half of `recordTaskFile`). A row of the same kind still current (same attempt when the kind is per
 * attempt, any when not) is superseded by this one: «latest» is the supersedes chain inside the task, never a time order of files.
 */
export function recordTaskFileRow(db: LanePilotDatabase, input: {
  taskId: string; kind: TaskFileKind; path: string; content: string; producer: TaskFileProducer; attemptId?: string | null; round?: number | null;
  readers?: readonly string[]; now?: number;
}): TaskFileRow {
  if (!isTaskFileKind(input.kind)) throw new Error(`unknown task file kind ${String(input.kind)}`);
  if (!taskHomeOf(db, input.taskId)) throw new Error(`task ${input.taskId} has no task home (it runs on the old layout)`);
  const path = cleanName(input.path);
  const sha = sha256Hex(input.content);
  const now = input.now ?? Date.now();
  db.transaction(() => {
    const current = db.prepare("SELECT path FROM lane_pilot_task_file WHERE task_id=? AND kind=? AND superseded_by IS NULL AND path<>? ORDER BY created_at DESC, rowid DESC")
      .all(input.taskId, input.kind, path) as Array<{ path: string }>;
    const supersedes = current[0]?.path ?? null;
    if (current.length) db.prepare("UPDATE lane_pilot_task_file SET superseded_by=? WHERE task_id=? AND kind=? AND superseded_by IS NULL AND path<>?").run(path, input.taskId, input.kind, path);
    db.prepare(`INSERT INTO lane_pilot_task_file(task_id,path,kind,attempt_id,round,sha256,bytes,producer_json,plugin_version,readers_json,supersedes,superseded_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?)
      ON CONFLICT(task_id,path) DO UPDATE SET kind=excluded.kind, attempt_id=excluded.attempt_id, round=excluded.round, sha256=excluded.sha256, bytes=excluded.bytes,
        producer_json=excluded.producer_json, plugin_version=excluded.plugin_version, readers_json=excluded.readers_json,
        supersedes=COALESCE(excluded.supersedes, lane_pilot_task_file.supersedes), superseded_by=NULL, created_at=excluded.created_at`)
      .run(input.taskId, path, input.kind, input.attemptId ?? null, input.round ?? null, sha, Buffer.byteLength(input.content, "utf8"),
        JSON.stringify(input.producer), packageJson.version, JSON.stringify([...(input.readers ?? [])]), supersedes, now);
  })();
  return db.prepare("SELECT * FROM lane_pilot_task_file WHERE task_id=? AND path=?").get(input.taskId, path) as TaskFileRow;
}

/** The fixed old-layout path of a kind (relative to the task's base checkout), by exact name; null for a kind the old layout never had. */
export function legacyTaskFilePath(taskId: string, runId: string | null, kind: TaskFileKind): string | null {
  const items = `.agents/plans/items/${taskId}`;
  const artifacts = runId ? `.agents/runs/${runId}/artifacts/${taskId}` : null;
  switch (kind) {
    case "plan": return `${items}/PLAN.md`;
    case "reflexes": return `${items}/REFLEXES.md`;
    case "filecards": return `${items}/FILECARDS.md`;
    case "qa": return `${items}/QA.md`;
    case "questions": return `${items}/QUESTIONS.md`;
    case "checkpoint": return `${items}/CHECKPOINT.md`;
    case "outcome": return `${items}/OUTCOME.md`;
    case "acceptance": return artifacts && `${artifacts}/acceptance.json`;
    case "receipt": return artifacts && `${artifacts}/lane-pilot-receipt.json`;
    case "progress": return artifacts && `${artifacts}/PROGRESS.md`;
    default: return null;
  }
}

export type ResolvedTaskFile = {
  taskId: string; kind: TaskFileKind;
  /** Relative to the task home (new layout) or to the base checkout (legacy). */
  path: string;
  /** Repository-relative path, the same in the base checkout and in the task's worktree. */
  repoPath: string;
  /** Absolute path in the base checkout. */
  absPath: string;
  basePath: string;
  sha256: string | null; attemptId: string | null; round: number | null; legacy: boolean;
};

/**
 * Where the file of `kind` of a task is, by the manifest: the current row of that kind (of that attempt when `attemptId` is given), or null.
 * A task on the old layout resolves to the kind's fixed old path (`legacy: true`); a task with a home never falls back to an old path.
 */
export function resolveTaskFile(db: LanePilotDatabase, taskId: string, kind: TaskFileKind, opts: { attemptId?: string } = {}): ResolvedTaskFile | null {
  const home = taskHomeOf(db, taskId);
  if (!home) {
    const task = db.prepare("SELECT run_id FROM lane_pilot_task WHERE id=?").get(taskId) as { run_id: string } | undefined;
    const base = task ? taskBasePath(db, task.run_id, taskId) : null;
    const rel = legacyTaskFilePath(taskId, task?.run_id ?? null, kind);
    if (!base || !rel) return null;
    return { taskId, kind, path: rel, repoPath: rel, absPath: `${base}/${rel}`, basePath: base, sha256: null, attemptId: null, round: null, legacy: true };
  }
  const rows = (opts.attemptId
    ? db.prepare("SELECT * FROM lane_pilot_task_file WHERE task_id=? AND kind=? AND attempt_id=?").all(taskId, kind, opts.attemptId)
    : db.prepare("SELECT * FROM lane_pilot_task_file WHERE task_id=? AND kind=? AND superseded_by IS NULL").all(taskId, kind)) as TaskFileRow[];
  // Inside one attempt: the row nothing of the same attempt supersedes (the chain's end), never a guess by time.
  const paths = new Set(rows.map((row) => row.path));
  const ends = rows.filter((row) => !row.superseded_by || !paths.has(row.superseded_by));
  if (ends.length !== 1) return null;
  const row = ends[0]!;
  const repoPath = `${taskHomeRel(taskId)}/${row.path}`;
  return { taskId, kind, path: row.path, repoPath, absPath: `${home.base_path}/${repoPath}`, basePath: home.base_path, sha256: row.sha256, attemptId: row.attempt_id, round: row.round, legacy: false };
}

/** A reader's use of a task file: the manifest's `read_by`, and for an old-layout file the legacy counter. */
export function noteTaskFileRead(db: LanePilotDatabase, input: { taskId: string; path: string; kind: TaskFileKind; reader: string; sha256: string | null; legacy: boolean; now?: number }): void {
  if (!tablesReady(db)) return;
  db.prepare("INSERT INTO lane_pilot_task_file_read(task_id,path,kind,reader,sha256,legacy,at) VALUES(?,?,?,?,?,?,?)")
    .run(input.taskId, input.path, input.kind, input.reader, input.sha256, input.legacy ? 1 : 0, input.now ?? Date.now());
}

/** How many reads went to old-layout files (one task, or all): the old reader may go once this stays 0 for 30 days (docs/task-folder.md). */
export function legacyReadCount(db: LanePilotDatabase, opts: { taskId?: string; since?: number } = {}): number {
  if (!tablesReady(db)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM lane_pilot_task_file_read WHERE legacy=1${opts.taskId ? " AND task_id=?" : ""}${opts.since ? " AND at>=?" : ""}`)
    .get(...[opts.taskId, opts.since].filter((value) => value !== undefined)) as { n: number };
  return row.n;
}

/** The task's manifest (`lp.task-manifest/1`) as the database holds it: deterministic for the same rows. */
export function renderTaskManifest(db: LanePilotDatabase, taskId: string): Record<string, unknown> | null {
  const home = taskHomeOf(db, taskId);
  if (!home) return null;
  const files = listTaskFiles(db, taskId);
  const reads = db.prepare("SELECT path, kind, reader, sha256, legacy, at FROM lane_pilot_task_file_read WHERE task_id=? ORDER BY at, rowid").all(taskId) as
    Array<{ path: string; kind: string; reader: string; sha256: string | null; legacy: number; at: number }>;
  const contract = [...files].reverse().find((row) => row.kind === "contract" && !row.superseded_by);
  const edition = contract ? Number(/contract\.v(\d+)\.json$/.exec(contract.path)?.[1] ?? 0) || null : null;
  const legacy = new Map<string, { path: string; kind: string; reads: number; last_at: number }>();
  for (const read of reads.filter((row) => row.legacy === 1)) {
    const seen = legacy.get(read.path) ?? { path: read.path, kind: read.kind, reads: 0, last_at: 0 };
    seen.reads += 1; seen.last_at = Math.max(seen.last_at, read.at);
    legacy.set(read.path, seen);
  }
  return {
    schema: TASK_MANIFEST_SCHEMA,
    task_id: taskId,
    project_id: home.project_id,
    run_id: home.run_id,
    phase_id: home.phase_id,
    parent: home.phase_id ? { kind: "phase", id: home.phase_id, manifest: `.agents/phases/${home.phase_id}/manifest.json` } : { kind: "run", id: home.run_id },
    contract: contract ? { edition, sha256: contract.sha256, path: contract.path } : null,
    files: files.map((row) => ({
      path: row.path,
      kind: row.kind,
      ...(row.attempt_id ? { attempt_id: row.attempt_id } : {}),
      ...(row.round !== null ? { round: row.round } : {}),
      produced_by: JSON.parse(row.producer_json) as TaskFileProducer,
      plugin_version: row.plugin_version,
      sha256: row.sha256,
      bytes: row.bytes,
      created_at: row.created_at,
      ...(row.supersedes ? { supersedes: row.supersedes } : {}),
      ...(row.superseded_by ? { superseded_by: row.superseded_by } : {}),
      readers: JSON.parse(row.readers_json) as string[],
      read_by: reads.filter((read) => read.legacy === 0 && read.path === row.path).map((read) => ({ node: read.reader, at: read.at, sha256: read.sha256 })),
    })),
    legacy: [...legacy.values()],
  };
}

export const renderTaskManifestJson = (db: LanePilotDatabase, taskId: string): string | null => {
  const manifest = renderTaskManifest(db, taskId);
  return manifest ? `${JSON.stringify(manifest, null, 2)}\n` : null;
};

/** The file side of the home: read and write absolute paths on the task's host. A missing file reads as null. */
export type TaskFileIo = { read(absPath: string): Promise<string | null>; write(absPath: string, content: string): Promise<void> };

const manifestWrites = new Map<string, Promise<void>>();

/** Writes `manifest.json` from the database, one write at a time per task, so a slower render never lands over a newer one. */
export async function writeTaskManifest(db: LanePilotDatabase, io: TaskFileIo, taskId: string): Promise<void> {
  const home = taskHomeOf(db, taskId);
  if (!home) return;
  const previous = manifestWrites.get(taskId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const json = renderTaskManifestJson(db, taskId);
    if (json) await io.write(`${taskHomeAbs(home.base_path, taskId)}/${TASK_MANIFEST_FILE}`, json);
  });
  manifestWrites.set(taskId, next);
  try { await next; } finally { if (manifestWrites.get(taskId) === next) manifestWrites.delete(taskId); }
}

/**
 * The one writer of a task's files: the file under the home in the base checkout, its row, and `manifest.json` again. A failed write throws:
 * the caller decides whether that stops its node (the task-folder node stops the pipeline).
 */
export async function recordTaskFile(db: LanePilotDatabase, io: TaskFileIo, input: {
  taskId: string; kind: TaskFileKind; name: string; content: string; producer: TaskFileProducer; attemptId?: string | null; round?: number | null; readers?: readonly string[];
  /** Also writes the same file at the same repository path under this checkout (the task's worktree), so the running writer sees it. */
  mirror?: { io: TaskFileIo; root: string } | null;
}): Promise<ResolvedTaskFile> {
  const home = taskHomeOf(db, input.taskId);
  if (!home) throw new Error(`task ${input.taskId} has no task home (it runs on the old layout)`);
  const name = cleanName(input.name);
  const repoPath = `${taskHomeRel(input.taskId)}/${name}`;
  const absPath = `${home.base_path}/${repoPath}`;
  await io.write(absPath, input.content);
  const row = recordTaskFileRow(db, { ...input, path: name });
  await writeTaskManifest(db, io, input.taskId);
  if (input.mirror && input.mirror.root.replace(/\/+$/, "") !== home.base_path) await input.mirror.io.write(`${input.mirror.root.replace(/\/+$/, "")}/${repoPath}`, input.content);
  return { taskId: input.taskId, kind: input.kind, path: name, repoPath, absPath, basePath: home.base_path, sha256: row.sha256, attemptId: row.attempt_id, round: row.round, legacy: false };
}

export type ReadTaskFile = ResolvedTaskFile & { text: string; recordedSha256: string | null; drift: boolean };

/**
 * Resolves and reads the file of `kind` for `reader`, and records the read (`read_by`; for an old-layout file the legacy counter). Null when the
 * manifest has no such file or the file is gone. `drift` tells a file whose content no longer matches the hash its row recorded.
 */
export async function readTaskFile(db: LanePilotDatabase, io: TaskFileIo, input: { taskId: string; kind: TaskFileKind; reader: string; attemptId?: string; refreshManifest?: boolean }): Promise<ReadTaskFile | null> {
  const found = resolveTaskFile(db, input.taskId, input.kind, input.attemptId ? { attemptId: input.attemptId } : {});
  if (!found) return null;
  const text = await io.read(found.absPath);
  if (text === null) return null;
  const sha = sha256Hex(text);
  noteTaskFileRead(db, { taskId: input.taskId, path: found.path, kind: input.kind, reader: input.reader, sha256: sha, legacy: found.legacy });
  if (!found.legacy && input.refreshManifest !== false) await writeTaskManifest(db, io, input.taskId).catch(() => undefined);
  return { ...found, text, recordedSha256: found.sha256, sha256: sha, drift: found.sha256 !== null && found.sha256 !== sha };
}

/** The old layout's own files a worktree of a task on it gets (by exact name; never another task's folder). */
const LEGACY_PLACED: TaskFileKind[] = ["plan", "reflexes", "filecards", "qa"];

/**
 * Puts the task's own home, and nothing else, into its worktree: every file its manifest lists, plus `manifest.json`. A task on the old layout
 * gets its own `.agents/plans/items/<id>/` notes by exact name. Plugin code moves the files; the agent never copies a folder. Returns the
 * repository paths placed.
 */
export async function placeTaskHome(db: LanePilotDatabase, from: TaskFileIo, to: TaskFileIo, input: { taskId: string; worktreePath: string }): Promise<string[]> {
  const root = input.worktreePath.replace(/\/+$/, "");
  const home = taskHomeOf(db, input.taskId);
  const placed: string[] = [];
  if (!home) {
    for (const kind of LEGACY_PLACED) {
      const found = resolveTaskFile(db, input.taskId, kind);
      if (!found || resolveSame(found.basePath, root)) continue;
      const text = await from.read(found.absPath);
      if (text === null) continue;
      await to.write(`${root}/${found.repoPath}`, text);
      placed.push(found.repoPath);
    }
    return placed;
  }
  if (resolveSame(home.base_path, root)) return placed;
  for (const row of listTaskFiles(db, input.taskId)) {
    const repoPath = `${taskHomeRel(input.taskId)}/${row.path}`;
    const text = await from.read(`${home.base_path}/${repoPath}`);
    if (text === null) continue;
    await to.write(`${root}/${repoPath}`, text);
    placed.push(repoPath);
  }
  const manifest = renderTaskManifestJson(db, input.taskId);
  if (manifest) { await to.write(`${root}/${taskHomeRel(input.taskId)}/${TASK_MANIFEST_FILE}`, manifest); placed.push(`${taskHomeRel(input.taskId)}/${TASK_MANIFEST_FILE}`); }
  return placed;
}

const resolveSame = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
