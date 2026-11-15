import { spawnAsync } from "@lane-pilot/kit";

/**
 * Runs SQL the way `sqlite3 -readonly <db>` fed from stdin did (scripts/lp-metrics-daily.sh): every statement in order, the rows of a
 * SELECT printed as text (columns joined by `|`, NULL as empty), a failing statement reported and skipped, the rest still run.
 *
 * It runs in a child process, not in the plugin's own SQLite: BB holds `bb.db` with its own SQLite, and a second copy in the same process
 * that opens the file truncates the `-shm` file under BB's mapping (the SIGBUS of 2026-11-07..11, see native-agent/server/profile-check.ts).
 * Between two processes the file locks hold. The plugin's own `data.db` is read the same way, so one child sees both (core is attached).
 */
export type SqlResult = { lines: string[]; errors: string[] };
/** `core` attaches a database file (generic runner use); `snapshot` materializes SDK-fetched core facts as an in-memory `core` schema — the daily report's path, which never attaches the real bb.db. */
export type SqlJob = { file: string; core?: string | null; snapshot?: import("./core-snapshot").CoreSnapshot | null; script: string };
export type SqlRun = (job: SqlJob) => Promise<SqlResult>;

/** Splits a script into statements at `;` outside quotes and comments; blank and comment-only pieces are dropped. */
export function splitSql(script: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) { if (script[i + 1] === quote) { current += script[i + 1]; i += 1; } else quote = null; }
      continue;
    }
    if (ch === "-" && script[i + 1] === "-") { while (i < script.length && script[i] !== "\n") i += 1; current += "\n"; continue; }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ";") { if (current.trim()) out.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const READER = `const { DatabaseSync } = require("node:sqlite");
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  const lines = [], errors = [];
  let db;
  try {
    db = new DatabaseSync(job.file, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    if (job.snapshot) {
      // ':memory:' inherits the read-only flag of the main file and refuses writes; the URI form opens read-write.
      db.exec("attach database 'file:lp_report_core?mode=memory' as core");
      db.exec("create table core.projects(id text primary key, name text)");
      db.exec("create table core.threads(id text primary key, created_at integer)");
      db.exec("create table core.thread_plugin_metadata(thread_id text not null, plugin_id text not null, metadata_json text not null)");
      const ins = {
        projects: db.prepare("insert into core.projects values (?, ?)"),
        threads: db.prepare("insert into core.threads values (?, ?)"),
        metadata: db.prepare("insert into core.thread_plugin_metadata values (?, ?, ?)"),
      };
      for (const row of job.snapshot.projects) ins.projects.run(row.id, row.name);
      for (const row of job.snapshot.threads) ins.threads.run(row.id, row.created_at);
      for (const row of job.snapshot.threadPluginMetadata) ins.metadata.run(row.thread_id, row.plugin_id, row.metadata_json);
    } else if (job.core) db.exec("attach database '" + job.core.replace(/'/g, "''") + "' as core");
    for (const sql of job.statements) {
      try {
        const stmt = db.prepare(sql);
        if (stmt.columns().length === 0) { stmt.run(); continue; }
        for (const row of stmt.all()) lines.push(Object.values(row).map((v) => (v === null || v === undefined ? "" : String(v))).join("|"));
      } catch (error) { errors.push(String((error && error.message) || error)); }
    }
  } catch (error) { errors.push(String((error && error.message) || error)); }
  finally { try { db && db.close(); } catch {} }
  process.stdout.write(JSON.stringify({ lines, errors }));
});`;

export const runSqliteChild: SqlRun = async (job) => {
  const run = await spawnAsync(process.execPath, ["--no-warnings", "-e", READER], { input: JSON.stringify({ file: job.file, core: job.core ?? null, snapshot: job.snapshot ?? null, statements: splitSql(job.script) }), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new Error(run.error?.message ?? `the sqlite reader exited ${run.status}: ${run.stderr.slice(-300)}`);
  return JSON.parse(run.stdout) as SqlResult;
};
