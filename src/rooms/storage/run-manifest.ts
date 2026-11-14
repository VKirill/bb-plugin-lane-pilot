import { sha256Hex } from "@lane-pilot/kit";
import packageJson from "../../../package.json";
import type { LanePilotDatabase } from "./database";
import { TASK_MANIFEST_FILE } from "./task-manifest";
import type { TaskFileIo, TaskFileProducer } from "./task-manifest";

/**
 * The run folder (docs/task-folder.md, «The run folder»): a workflow-graph run keeps a manifest at `.agents/runs/<run-id>/manifest.json` in the checkout
 * its nodes write to. It lists every file the run's nodes wrote or spilled, wherever the file is (a domain folder, the PM chat's step-input spill), the
 * node that made it, the plugin version, and who read it. The sibling of the task manifest (`task-manifest.ts`, same `TaskFileIo`, same producer shape,
 * same rule: the database is the truth and the file its rendering, written by this module's callers only), keyed by the engine's run id.
 *
 * A reader never lists a folder: it asks `resolveRunFile` / `readRunFile` for `{run_id, kind, node_id}` or for one path, and an ambiguous answer is
 * refused, not guessed. A path several runs wrote (a daily «latest» pointer) is named by its newest producer (`resolveLatestPointer`), and every row
 * says which other run's file it replaced.
 */
export const RUN_MANIFEST_SCHEMA = "lp.run-manifest/1";
export const RUN_HOME_ROOT = ".agents/runs";

/**
 * `output`: a file an `fs.write` node made; `step-input`: a long input the engine spilled for a step packet; `latest-pointer`: a file at a fixed path that
 * each run replaces on purpose (the manifest names the run that wrote the current one).
 */
export const RUN_FILE_KINDS = ["output", "step-input", "latest-pointer"] as const;
export type RunFileKind = (typeof RUN_FILE_KINDS)[number];
export const isRunFileKind = (value: unknown): value is RunFileKind => typeof value === "string" && (RUN_FILE_KINDS as readonly string[]).includes(value);

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `.agents/runs/<id>` for a run id that can be a folder name, else null. */
export const runHomeRel = (runId: string): string | null => (RUN_ID.test(runId) ? `${RUN_HOME_ROOT}/${runId}` : null);

export type RunHomeRow = { run_id: string; project_id: string; workflow_id: string; base_path: string; host_id: string; parent_run_id: string | null; created_at: number };
export type RunFileRow = {
  run_id: string; repo_path: string; root: string; kind: RunFileKind; node_id: string; sha256: string; bytes: number;
  producer_json: string; plugin_version: string; readers_json: string; replaces: string | null; created_at: number;
};

function tablesReady(db: LanePilotDatabase): boolean {
  try { return (db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='lane_pilot_run_file'").get() as { ok?: number } | undefined)?.ok === 1; } catch { return false; }
}

/** The run's home row, or null for a run that wrote nothing (the folder is made by the first file, never for a run with nothing to list). */
export function runHomeOf(db: LanePilotDatabase, runId: string): RunHomeRow | null {
  if (!tablesReady(db)) return null;
  return (db.prepare("SELECT * FROM lane_pilot_run_home WHERE run_id=?").get(runId) as RunHomeRow | undefined) ?? null;
}

/** Opens a run's home: idempotent, the first base stays. */
export function openRunHome(db: LanePilotDatabase, input: { runId: string; projectId: string; workflowId: string; basePath: string; hostId: string; parentRunId?: string | null; now?: number }): RunHomeRow {
  if (!runHomeRel(input.runId)) throw new Error(`run id ${input.runId} cannot name a run home`);
  db.prepare("INSERT OR IGNORE INTO lane_pilot_run_home(run_id,project_id,workflow_id,base_path,host_id,parent_run_id,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(input.runId, input.projectId, input.workflowId, input.basePath.replace(/\/+$/, ""), input.hostId, input.parentRunId ?? null, input.now ?? Date.now());
  return runHomeOf(db, input.runId)!;
}

export function listRunFiles(db: LanePilotDatabase, runId: string): RunFileRow[] {
  if (!tablesReady(db)) return [];
  return db.prepare("SELECT * FROM lane_pilot_run_file WHERE run_id=? ORDER BY created_at, rowid").all(runId) as RunFileRow[];
}

function cleanRepoPath(path: string): string {
  const rel = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!rel || rel.startsWith("/") || rel.includes("\0") || rel.split("/").some((part) => part === ".." || part === "")) throw new Error(`«${path}» is not a repository-relative file path`);
  return rel;
}

/**
 * Records one file row. When another run's row already holds the same path, this row says so in `replaces` (`<run>:<path>`): a rerun on a shared path is
 * a recorded replacement, never a silent one.
 */
export function recordRunFileRow(db: LanePilotDatabase, input: {
  runId: string; repoPath: string; kind: RunFileKind; nodeId: string; content: string; producer: TaskFileProducer;
  root?: "checkout" | "planning-home"; readers?: readonly string[]; now?: number;
}): RunFileRow {
  if (!isRunFileKind(input.kind)) throw new Error(`unknown run file kind ${String(input.kind)}`);
  if (!runHomeOf(db, input.runId)) throw new Error(`run ${input.runId} has no run home`);
  const repoPath = cleanRepoPath(input.repoPath);
  const other = db.prepare("SELECT run_id FROM lane_pilot_run_file WHERE repo_path=? AND run_id<>? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(repoPath, input.runId) as { run_id: string } | undefined;
  // The same value spilled for two steps is one file: its readers are every step it was given to.
  const mine = db.prepare("SELECT readers_json FROM lane_pilot_run_file WHERE run_id=? AND repo_path=?").get(input.runId, repoPath) as { readers_json: string } | undefined;
  const readers = [...new Set([...(mine ? JSON.parse(mine.readers_json) as string[] : []), ...(input.readers ?? [])])];
  db.prepare(`INSERT INTO lane_pilot_run_file(run_id,repo_path,root,kind,node_id,sha256,bytes,producer_json,plugin_version,readers_json,replaces,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id,repo_path) DO UPDATE SET root=excluded.root, kind=excluded.kind, node_id=excluded.node_id, sha256=excluded.sha256, bytes=excluded.bytes,
      producer_json=excluded.producer_json, plugin_version=excluded.plugin_version, readers_json=excluded.readers_json,
      replaces=COALESCE(excluded.replaces, lane_pilot_run_file.replaces), created_at=excluded.created_at`)
    .run(input.runId, repoPath, input.root ?? "checkout", input.kind, input.nodeId, sha256Hex(input.content), Buffer.byteLength(input.content, "utf8"),
      JSON.stringify(input.producer), packageJson.version, JSON.stringify(readers), other ? `${other.run_id}:${repoPath}` : null, input.now ?? Date.now());
  return db.prepare("SELECT * FROM lane_pilot_run_file WHERE run_id=? AND repo_path=?").get(input.runId, repoPath) as RunFileRow;
}

export type ResolvedRunFile = { runId: string; kind: RunFileKind; nodeId: string; repoPath: string; root: string; absPath: string; basePath: string; sha256: string };

const resolved = (home: RunHomeRow, row: RunFileRow): ResolvedRunFile =>
  ({ runId: row.run_id, kind: row.kind, nodeId: row.node_id, repoPath: row.repo_path, root: row.root, absPath: `${home.base_path}/${row.repo_path}`, basePath: home.base_path, sha256: row.sha256 });

/**
 * Where a run's file is, by the manifest: the one file at `repoPath`, or the one file of `kind` that `nodeId` wrote. Null when there is none or when the
 * answer is not unique (a node that wrote two files of one kind must be asked by path): the resolver never picks «the newest».
 */
export function resolveRunFile(db: LanePilotDatabase, runId: string, ask: { kind: RunFileKind; nodeId?: string; repoPath?: string }): ResolvedRunFile | null {
  const home = runHomeOf(db, runId);
  if (!home) return null;
  const rows = (ask.repoPath
    ? db.prepare("SELECT * FROM lane_pilot_run_file WHERE run_id=? AND kind=? AND repo_path=?").all(runId, ask.kind, ask.repoPath)
    : ask.nodeId
      ? db.prepare("SELECT * FROM lane_pilot_run_file WHERE run_id=? AND kind=? AND node_id=?").all(runId, ask.kind, ask.nodeId)
      : db.prepare("SELECT * FROM lane_pilot_run_file WHERE run_id=? AND kind=?").all(runId, ask.kind)) as RunFileRow[];
  return rows.length === 1 ? resolved(home, rows[0]!) : null;
}

/**
 * The file at a fixed path that each run replaces on purpose (a daily «latest» bridge), named by the run that wrote the current one: the newest
 * `latest-pointer` row of that path in the project. The answer carries the run, so a reader can say which run's file it took.
 */
export function resolveLatestPointer(db: LanePilotDatabase, projectId: string, repoPath: string): ResolvedRunFile | null {
  if (!tablesReady(db)) return null;
  const row = db.prepare(`SELECT f.* FROM lane_pilot_run_file f JOIN lane_pilot_run_home h ON h.run_id=f.run_id
    WHERE h.project_id=? AND f.repo_path=? AND f.kind='latest-pointer' ORDER BY f.created_at DESC, f.rowid DESC LIMIT 1`).get(projectId, repoPath) as RunFileRow | undefined;
  const home = row ? runHomeOf(db, row.run_id) : null;
  return row && home ? resolved(home, row) : null;
}

export function noteRunFileRead(db: LanePilotDatabase, input: { runId: string; repoPath: string; kind: RunFileKind; reader: string; sha256: string | null; now?: number }): void {
  if (!tablesReady(db)) return;
  db.prepare("INSERT INTO lane_pilot_run_file_read(run_id,repo_path,kind,reader,sha256,at) VALUES(?,?,?,?,?,?)").run(input.runId, input.repoPath, input.kind, input.reader, input.sha256, input.now ?? Date.now());
}

/** The run's manifest (`lp.run-manifest/1`) as the database holds it: deterministic for the same rows. */
export function renderRunManifest(db: LanePilotDatabase, runId: string): Record<string, unknown> | null {
  const home = runHomeOf(db, runId);
  if (!home) return null;
  const reads = db.prepare("SELECT repo_path, reader, sha256, at FROM lane_pilot_run_file_read WHERE run_id=? ORDER BY at, rowid").all(runId) as Array<{ repo_path: string; reader: string; sha256: string | null; at: number }>;
  return {
    schema: RUN_MANIFEST_SCHEMA,
    run_id: runId,
    project_id: home.project_id,
    workflow_id: home.workflow_id,
    parent: home.parent_run_id ? { kind: "run", id: home.parent_run_id, manifest: `${runHomeRel(home.parent_run_id) ?? RUN_HOME_ROOT}/${TASK_MANIFEST_FILE}` } : null,
    files: listRunFiles(db, runId).map((row) => ({
      path: row.repo_path,
      root: row.root,
      kind: row.kind,
      produced_by: JSON.parse(row.producer_json) as TaskFileProducer,
      plugin_version: row.plugin_version,
      sha256: row.sha256,
      bytes: row.bytes,
      created_at: row.created_at,
      ...(row.replaces ? { replaces: row.replaces } : {}),
      readers: JSON.parse(row.readers_json) as string[],
      read_by: reads.filter((read) => read.repo_path === row.repo_path).map((read) => ({ node: read.reader, at: read.at, sha256: read.sha256 })),
    })),
  };
}

export const renderRunManifestJson = (db: LanePilotDatabase, runId: string): string | null => {
  const manifest = renderRunManifest(db, runId);
  return manifest ? `${JSON.stringify(manifest, null, 2)}\n` : null;
};

const manifestWrites = new Map<string, Promise<void>>();

/** Writes `.agents/runs/<id>/manifest.json` from the database, one write at a time per run, so a slower render never lands over a newer one. */
export async function writeRunManifest(db: LanePilotDatabase, io: TaskFileIo, runId: string): Promise<void> {
  const home = runHomeOf(db, runId);
  const rel = runHomeRel(runId);
  if (!home || !rel) return;
  const previous = manifestWrites.get(runId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const json = renderRunManifestJson(db, runId);
    if (json) await io.write(`${home.base_path}/${rel}/${TASK_MANIFEST_FILE}`, json);
  });
  manifestWrites.set(runId, next);
  try { await next; } finally { if (manifestWrites.get(runId) === next) manifestWrites.delete(runId); }
}

/**
 * The one writer of a run's file rows: records the file the caller has already written (or spilled) and renders `manifest.json` again. The manifest
 * file is a rendering: if it cannot be written the row stays and the next record renders it again, so the caller gets the error to log, not to stop on.
 */
export async function recordRunFile(db: LanePilotDatabase, io: TaskFileIo, input: Parameters<typeof recordRunFileRow>[1]): Promise<ResolvedRunFile> {
  const row = recordRunFileRow(db, input);
  await writeRunManifest(db, io, input.runId);
  return resolved(runHomeOf(db, input.runId)!, row);
}

export type ReadRunFile = ResolvedRunFile & { text: string; drift: boolean };

/** Resolves and reads a run's file for `reader`, and records the read (`read_by`). Null when the manifest has no such file or the file is gone. */
export async function readRunFile(db: LanePilotDatabase, io: TaskFileIo, input: { runId: string; kind: RunFileKind; nodeId?: string; repoPath?: string; reader: string }): Promise<ReadRunFile | null> {
  const found = resolveRunFile(db, input.runId, { kind: input.kind, ...(input.nodeId ? { nodeId: input.nodeId } : {}), ...(input.repoPath ? { repoPath: input.repoPath } : {}) });
  if (!found) return null;
  const text = await io.read(found.absPath);
  if (text === null) return null;
  const sha = sha256Hex(text);
  noteRunFileRead(db, { runId: found.runId, repoPath: found.repoPath, kind: found.kind, reader: input.reader, sha256: sha });
  await writeRunManifest(db, io, found.runId).catch(() => undefined);
  return { ...found, text, drift: sha !== found.sha256 };
}
