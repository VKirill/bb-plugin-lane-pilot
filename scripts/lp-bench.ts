/**
 * Runs `bb lane-pilot bench …` from outside BB, against the LIVE hub: the same room code (src/rooms/bench) with the two ports implemented by
 * a shell on the machines and by `bb lane-pilot …` plus read-only hub queries, the way scripts/lp-drill.py drives the pipeline. It exists for the
 * time before the plugin carrying the bench is deployed (the deployed plugin has no `bench` command); afterwards use `bb lane-pilot bench …`.
 *
 *   npx esbuild scripts/lp-bench.ts --bundle --platform=node --format=esm --outfile=/tmp/lp-bench.mjs --external:better-sqlite3 --external:@get-bb/plugin-sdk \
 *     --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" && node /tmp/lp-bench.mjs refresh-snapshot
 *   node /tmp/lp-bench.mjs bench build --set v1 --dry-run
 *   node /tmp/lp-bench.mjs bench run --arm luna-a --set v1 --tasks 3 --wait
 *
 * State lives in LP_BENCH_HOME (default ~/lp-bench): bench.db is a copy of the hub's Lane Pilot database (taken read-only with sqlite3 .backup) plus the bench
 * tables; sets, series and results are written there. `refresh-snapshot` takes a new copy and keeps the bench tables.
 * Env: LP_BENCH_HUB (ubuntu@10.8.0.1), LP_BENCH_KEY, LP_BENCH_HUB_DB, LP_BENCH_SSH_OVH (ssh alias of the OVH machine), BB_CLI.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { runBenchCli } from "../src/rooms/bench/cli";
import { benchMigrations } from "../src/rooms/bench/migrations";
import { q, type BenchProjectRef, type ExecResult, type HostPort, type PipelinePort } from "../src/rooms/bench/ports";
import { DEFAULT_BENCH_WRITER, defaultProjectName } from "../src/rooms/bench/runner";
import { createBench } from "../src/rooms/bench/service";
import { isSandboxProjectName } from "../src/rooms/stability/server";
import { attemptMetrics } from "../src/rooms/usage/server/attempt-metrics";
import { openDatabase } from "../src/rooms/storage/database";

const HOME = process.env.LP_BENCH_HOME ?? join(homedir(), "lp-bench");
const HUB = process.env.LP_BENCH_HUB ?? "ubuntu@10.8.0.1";
const KEY = process.env.LP_BENCH_KEY ?? join(homedir(), ".ssh/oracle_bb");
const HUB_DB = process.env.LP_BENCH_HUB_DB ?? "/home/ubuntu/.bb/plugins/lane-pilot/data.db";
const OVH = process.env.LP_BENCH_SSH_OVH ?? "ovh-main";
const BB = process.env.BB_CLI ?? "bb";
const LOCAL_HOST = "host_7sea4qaad8", OVH_HOST = "host_rwrxyi39aw";
const log = (line: string) => console.error(`${new Date().toISOString().slice(11, 19)} bench: ${line}`);

function exec(file: string, args: string[], options: { cwd?: string; input?: string; timeoutSec?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd ?? "/", env: process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = options.timeoutSec ? setTimeout(() => child.kill("SIGKILL"), options.timeoutSec * 1000) : null;
    child.on("error", (error) => { if (timer) clearTimeout(timer); resolve({ exitCode: 127, stdout, stderr: String(error) }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ exitCode: code ?? 255, stdout, stderr }); });
    child.stdin.end(options.input ?? "");
  });
}

const host: HostPort = {
  run: (hostId, cwd, command, timeoutSec = 120) => {
    if (hostId === LOCAL_HOST || hostId === "local") return exec("/bin/sh", ["-c", command], { cwd, timeoutSec });
    if (hostId === OVH_HOST) return exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", OVH, `cd ${q(cwd)} && ${command}`], { timeoutSec: timeoutSec + 20 });
    return Promise.resolve({ exitCode: 127, stdout: "", stderr: `the live driver cannot reach ${hostId}` });
  },
};

async function hubRows(sql: string): Promise<Array<Record<string, unknown>>> {
  const result = await exec("ssh", ["-i", KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HUB, `sqlite3 -readonly -json '${HUB_DB}'`], { input: sql, timeoutSec: 90 });
  if (result.exitCode !== 0) throw new Error(`hub query failed: ${result.stderr.trim().slice(0, 200)}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) as Array<Record<string, unknown>> : [];
}
const lit = (text: string) => `'${text.replace(/'/g, "''")}'`;

async function bb(...args: string[]): Promise<ExecResult> { return exec(BB, args, { timeoutSec: 240 }); }
const field = (raw: string, name: string): string => { try { const data = JSON.parse(raw); const inner = data?.thread ?? data; return String(inner?.[name] ?? ""); } catch { return ""; } };

async function rpc(method: string, payload: unknown): Promise<Record<string, unknown>> {
  const file = join(HOME, `.rpc-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(payload));
  const result = await bb("plugin", "rpc", "call", "lane-pilot", method, "--input-file", file, "--json");
  if (result.exitCode !== 0) throw new Error(`${method} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  const data = JSON.parse(result.stdout) as Record<string, unknown>;
  return (data.result ?? data) as Record<string, unknown>;
}

const TABLES: Array<[string, (runId: string, projectId: string) => string]> = [
  ["lane_pilot_run", (r) => `select * from lane_pilot_run where id=${lit(r)}`],
  ["lane_pilot_task", (r) => `select * from lane_pilot_task where run_id=${lit(r)}`],
  ["lane_pilot_attempt", (r) => `select * from lane_pilot_attempt where run_id=${lit(r)}`],
  ["lane_pilot_stage_event", (r) => `select * from lane_pilot_stage_event where run_id=${lit(r)}`],
  ["lane_pilot_gate_event", (r) => `select * from lane_pilot_gate_event where run_id=${lit(r)}`],
  ["lane_pilot_stage_receipt", (r) => `select * from lane_pilot_stage_receipt where run_id=${lit(r)}`],
  ["lane_pilot_token_cursor", (r) => `select * from lane_pilot_token_cursor where thread_id in (select thread_id from lane_pilot_attempt where run_id=${lit(r)} and thread_id is not null)`],
];

/** The rows of one run, copied into a scratch database that has the plugin's own schema, so `attemptMetrics` is the real function on real rows. */
async function sliceOfRun(runId: string, projectId: string) {
  const { bb: fakeBb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(fakeBb);
  db.pragma("foreign_keys = OFF");
  for (const [table, sql] of TABLES) {
    const rows = await hubRows(sql(runId, projectId));
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    for (const row of rows) {
      const columns = Object.keys(row).filter((c) => have.has(c));
      db.prepare(`INSERT OR REPLACE INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map((c) => row[c] as never));
    }
  }
  return db;
}

const writtenKeys = (projectId: string) => join(HOME, `keys-${projectId}.json`);

let configureTurn: Promise<void> = Promise.resolve();

async function configureProject(project: BenchProjectRef, input: { settings: Record<string, unknown>; harness: string; sourceProjectId: string | null }): Promise<void> {
  if (input.harness !== "none") throw new Error(`the deployed plugin cannot run a harness arm (${input.harness}); deploy the bench first`);
  const state = await hubRows(`select 1 as x from lane_pilot_project_settings where project_id=${lit(project.projectId)} and key='hostId'`);
  if (!state.length) {
    const configured = await bb("lane-pilot", "configure", JSON.stringify({ projectId: project.projectId, hostId: project.hostId, pmWorkspacePath: project.path, writerWorkspacePath: project.path,
      pmProviderId: DEFAULT_BENCH_WRITER.providerId, pmModel: DEFAULT_BENCH_WRITER.model, writerProviderId: DEFAULT_BENCH_WRITER.providerId, writerModel: DEFAULT_BENCH_WRITER.model }));
    if (configured.exitCode !== 0) throw new Error(`configure failed: ${(configured.stderr || configured.stdout).trim().slice(0, 300)}`);
  }
  const before: string[] = existsSync(writtenKeys(project.projectId)) ? JSON.parse(readFileSync(writtenKeys(project.projectId), "utf8")) : [];
  const versions = new Map<string, number>((await hubRows(`select key, version from lane_pilot_project_settings where project_id=${lit(project.projectId)} and binding_id=''`)).map((row) => [String(row.key), Number(row.version)]));
  const stale = before.filter((key) => !(key in input.settings) && versions.has(key));
  if (stale.length) await rpc("reset_project_settings", { projectId: project.projectId, keys: stale, expectedVersions: Object.fromEntries(stale.map((key) => [key, versions.get(key)!])) });
  for (const [key, value] of Object.entries(input.settings)) {
    let saved = await rpc("save_setting", { projectId: project.projectId, key, value, expectedVersion: versions.get(key) ?? 0 });
    // A conflict names the version the setting has now (configure wrote it, an earlier arm did): write again against that.
    for (let again = 0; !saved.ok && saved.conflict && typeof saved.version === "number" && again < 4; again++) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (again + 1)));
      saved = await rpc("save_setting", { projectId: project.projectId, key, value, expectedVersion: saved.version });
    }
    if (!saved.ok) throw new Error(`could not set ${key}: ${JSON.stringify(saved).slice(0, 200)}`);
  }
  writeFileSync(writtenKeys(project.projectId), JSON.stringify(Object.keys(input.settings)));
  const provider = input.settings["writer.provider"], model = input.settings["writer.model"];
  if (typeof provider === "string" && typeof model === "string") spawnWriter.set(project.projectId, { providerId: provider, model });
}

const spawnWriter = new Map<string, { providerId: string; model: string }>();

const pipeline: PipelinePort = {
  async findProject(name) {
    const listed = await bb("project", "list", "--json", "--include-personal");
    if (listed.exitCode !== 0) throw new Error(`bb project list: ${listed.stderr.trim().slice(0, 200)}`);
    const found = (JSON.parse(listed.stdout) as Array<{ id: string; name: string; sources?: Array<{ hostId: string; path: string; isDefault?: boolean }> }>).find((p) => p.name === name);
    const source = found?.sources?.find((s) => s.isDefault) ?? found?.sources?.[0];
    return found && source ? { projectId: found.id, name, hostId: source.hostId, path: source.path } : null;
  },

  // One repository's group at a time: two groups writing settings at once make the plugin's version check conflict.
  configure(project, input) {
    const turn = configureTurn.then(() => configureProject(project, input));
    configureTurn = turn.catch(() => undefined);
    return turn;
  },

  async startRun(project) {
    // The clone is the project's folder: the thread works in it as an unmanaged workspace, on the project's machine.
    const writer = spawnWriter.get(project.projectId) ?? DEFAULT_BENCH_WRITER;
    const spawned = await bb("thread", "spawn", "--project", project.projectId, "--environment", project.path, "--machine", project.hostId, "--provider", writer.providerId, "--model", writer.model, "--prompt", "Reply with OK only.", "--json");
    const source = spawned.exitCode === 0 ? field(spawned.stdout, "id") : "";
    if (!source) throw new Error(`source thread did not start: ${(spawned.stderr || spawned.stdout).slice(0, 300)}`);
    for (let i = 0; i < 36; i++) {
      const shown = await bb("thread", "get", source, "--json");
      if (field(shown.stdout, "status") === "idle") break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    const activated = await bb("lane-pilot", "activate", project.projectId, source);
    const pm = field(activated.stdout, "threadId"), runId = field(activated.stdout, "runId");
    if (activated.exitCode !== 0 || !pm || !runId) throw new Error(`activate failed: ${(activated.stderr || activated.stdout).slice(0, 300)}`);
    // The PM prompt tells the PM to delegate a fixture task of its own; a bench run takes its tasks only from the bench, so the PM is stopped at once.
    await bb("thread", "stop", pm);
    log(`PM ${pm} (stopped), run ${runId} in ${project.name}`);
    return { pmThreadId: pm, runId };
  },

  async dispatch(project, pmThreadId, task) {
    const sent = await bb("lane-pilot", "dispatch-bb", project.projectId, pmThreadId, JSON.stringify(task));
    let state = "", taskId = "";
    try { const reply = JSON.parse(sent.stdout) as { state?: unknown; taskId?: unknown }; state = String(reply.state ?? ""); taskId = typeof reply.taskId === "string" ? reply.taskId : ""; } catch { /* not JSON: the exit code decides */ }
    return { ok: sent.exitCode === 0 && state !== "rejected" && state !== "failed" && state !== "validation_failed", detail: (sent.stdout + sent.stderr).trim().slice(0, 500), ...(taskId ? { taskId } : {}) };
  },
  async outcome(runId, taskId) {
    const rows = await hubRows(`select state, attempt_no from lane_pilot_attempt where run_id=${lit(runId)} and task_id=${lit(taskId)} order by created_at desc, attempt_no desc`);
    return { latestState: rows.length ? String(rows[0]!.state) : null, attempts: rows.length };
  },

  async metrics(project, runId, taskId) {
    // The token cursor of a writer thread is written by the plugin's usage sync, minutes after the attempt: ask for a sync and read again before calling the cost not measured.
    for (let round = 0; ; round++) {
      const db = await sliceOfRun(runId, project.projectId);
      const rows = attemptMetrics(db as never, { projectId: project.projectId, days: 3 }).attempts.filter((row) => row.taskId === taskId).sort((a, b) => a.attemptNo - b.attemptNo);
      const unseen = rows.some((row) => row.writer.threadId && row.costNote?.startsWith("no usage row"));
      if (!unseen || round >= 4) return rows;
      await rpc("token_usage_sync", {}).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  },

  async cancel(runId, taskId) {
    const open = await hubRows(`select id from lane_pilot_attempt where run_id=${lit(runId)} and task_id=${lit(taskId)} and state in ('queued','spawn_requested','spawn_unknown','running')`);
    for (const row of open) await bb("lane-pilot", "cancel", String(row.id));
  },

  async finishRun(project, runId) {
    const threads = await hubRows(`select thread_id as t from lane_pilot_attempt where run_id=${lit(runId)} and thread_id is not null union select holder_thread_id from lane_pilot_attempt where run_id=${lit(runId)} and holder_thread_id is not null`);
    for (let tries = 0; tries < 30; tries++) {
      const done = await bb("lane-pilot", "finish", project.projectId, runId);
      if (done.exitCode === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    for (const row of threads) await bb("thread", "archive", String(Object.values(row)[0]));
  },
};

function openBenchDb(): Database.Database {
  mkdirSync(HOME, { recursive: true });
  const path = join(HOME, "bench.db");
  if (!existsSync(path)) throw new Error(`no ${path}: run refresh-snapshot first`);
  const db = new Database(path);
  db.pragma("foreign_keys = OFF");
  const have = db.prepare("SELECT 1 FROM sqlite_master WHERE name='lane_pilot_bench_set'").get();
  if (!have) for (const statement of benchMigrations) db.exec(statement);
  return db;
}

async function refreshSnapshot(): Promise<void> {
  mkdirSync(HOME, { recursive: true });
  const target = join(HOME, "bench.db"), fresh = join(HOME, "hub-snapshot.db");
  const keep = existsSync(target) ? new Database(target, { readonly: true }) : null;
  const carried: Record<string, unknown[]> = {};
  if (keep && keep.prepare("SELECT 1 FROM sqlite_master WHERE name='lane_pilot_bench_set'").get()) {
    for (const table of ["lane_pilot_bench_set", "lane_pilot_bench_task", "lane_pilot_bench_run", "lane_pilot_bench_result", "lane_pilot_bench_noise", "lane_pilot_bench_verdict", "lane_pilot_bench_project"]) carried[table] = keep.prepare(`SELECT * FROM ${table}`).all();
  }
  keep?.close();
  execFileSync("ssh", ["-i", KEY, "-o", "BatchMode=yes", HUB, `sqlite3 -readonly '${HUB_DB}' ".backup /tmp/lpb-snapshot.db"`]);
  execFileSync("scp", ["-i", KEY, "-o", "BatchMode=yes", `${HUB}:/tmp/lpb-snapshot.db`, fresh]);
  execFileSync("ssh", ["-i", KEY, "-o", "BatchMode=yes", HUB, "rm -f /tmp/lpb-snapshot.db"]);
  execFileSync("mv", [fresh, target]);
  const db = new Database(target);
  db.pragma("foreign_keys = OFF");
  for (const statement of benchMigrations) db.exec(statement);
  for (const [table, rows] of Object.entries(carried)) {
    for (const row of rows as Array<Record<string, unknown>>) {
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map((c) => row[c] as never));
    }
  }
  db.close();
  log(`snapshot refreshed: ${target}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "refresh-snapshot") return await refreshSnapshot();
  if (command !== "bench") { console.error("usage: lp-bench.mjs refresh-snapshot | bench <build|show|prepare|run|noise|compare|status|config> …"); process.exit(2); }
  const db = openBenchDb();
  const kvFile = join(HOME, "kv.json");
  const kv: Record<string, unknown> = existsSync(kvFile) ? JSON.parse(readFileSync(kvFile, "utf8")) : {};
  const bench = createBench({
    db: db as never, kv: { get: async (key) => kv[key], set: async (key, value) => { kv[key] = value; writeFileSync(kvFile, JSON.stringify(kv)); } },
    host, pipeline, log, isSandboxName: isSandboxProjectName,
    // The deployed plugin (0.1.263) knows «LP sandbox …» as sandbox traffic, not yet «LP bench …»: until it carries the bench, its projects are named «LP sandbox bench …».
    ...(process.env.LP_BENCH_LEGACY_SANDBOX === "1" ? { projectNameFor: (task: Parameters<typeof defaultProjectName>[0]) => defaultProjectName(task).replace("LP bench", "LP sandbox bench") } : {}),
    projectNames: async () => new Map([["proj_acpiaqf4wq", "SelfyStudio"], ["proj_ejbam66722", "BB-сервис"], ["proj_a35nni238u", "Клиенты"]]),
  });
  // A background job would die with this process: the driver always waits.
  if ((rest[0] === "build" || rest[0] === "run") && !rest.includes("--wait")) rest.push("--wait");
  const result = await runBenchCli(bench, rest);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}

void main().catch((cause) => { console.error(cause instanceof Error ? cause.stack : String(cause)); process.exit(1); });
export type { BenchProjectRef };
