/**
 * Runs the wall journal and the night loop on a COPY of the hub's database, outside BB, to see what a night would have found and picked
 * (SMA P1-1, the live proof). Nothing is written to the copy that stays and no model is called; the hub is never touched.
 *
 *   ssh <hub> 'sqlite3 -readonly <data.db> ".backup /tmp/snap.db"'; scp the snapshot, the plugin.log files and
 *   ssh <hub> 'sqlite3 -readonly ~/.bb/bb.db "select id||char(9)||name from projects"' > projects.tsv
 *   npx esbuild scripts/wall-retro.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/wall-retro.mjs && node /tmp/wall-retro.mjs --db <copy> --projects projects.tsv --log plugin.log.1 --log plugin.log --nights 2026-10-19..2026-10-22
 *
 * Per night (03:00 UTC, the window being the 24 hours before it) it prints the classes with a failure in the window: origin, failures in the
 * window, the 3/10, 5/100, 6/500 counts, open or closed, and what the selection does with the class. `--window <from>..<to>` prints one free
 * window (the manual audit of 2026-10-19 ran 17:13 -> 10-20 10:02 UTC). `--dry-run-now` runs the real night service in dry-run mode on the
 * newest data.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { wallLogLines } from "../src/rooms/wall/logs";
import { createWall, type WallPorts } from "../src/rooms/wall/service";
import { classVersions, collectEntries, nightOf, refreshClasses, writeEntries } from "../src/rooms/wall/journal";
import { wallMigrations } from "../src/rooms/wall/migrations";
import { selectClasses } from "../src/rooms/wall/select";
import { WALL_DEFAULTS } from "../src/rooms/wall/config";

const arg = (name: string): string | undefined => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : undefined; };
const args = (name: string): string[] => process.argv.flatMap((word, index) => (word === `--${name}` ? [process.argv[index + 1]!] : []));
const dbPath = arg("db");
if (!dbPath) throw new Error("--db <copy of the hub data.db> is required");

const names = new Map<string, string>();
if (arg("projects")) for (const line of readFileSync(arg("projects")!, "utf8").split("\n")) { const [id, name] = line.split("\t"); if (id && name) names.set(id, name); }
const sandbox = (projectId: string) => projectId === "proj_3tb652jpsi" || /^LP (sandbox|native|bench)/.test(names.get(projectId) ?? "");
const isReal = (projectId: string, taskId: string) => !sandbox(projectId) && !taskId.startsWith("drill-");

const db = new Database(dbPath);
db.pragma("journal_mode = MEMORY");
for (const statement of wallMigrations) { try { db.exec(statement); } catch (cause) { if (!/already exists/.test(String(cause))) throw cause; } }
db.exec("CREATE TABLE IF NOT EXISTS lane_pilot_deferral_probe (x)");

const logText = args("log").map((file) => readFileSync(file, "utf8")).join("\n");
const logLinesIn = (since: number, until: number) => wallLogLines(logText, since, until).map((row) => ({ message: row.message, at: row.at, projectId: row.projectId }));

const DAY = 86_400_000;
const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));

function report(label: string, since: number, until: number): void {
  const entries = collectEntries(db, { since, until, isReal, logLines: logLinesIn(since, until), now: until });
  writeEntries(db, entries, until);
  const classes = refreshClasses(db, { now: until, isReal });
  const today = new Map<string, { n: number; tasks: number; versions: Set<string>; projects: Set<string>; sources: Record<string, number> }>();
  for (const entry of entries) {
    const row = today.get(entry.classKey) ?? { n: 0, tasks: 0, versions: new Set<string>(), projects: new Set<string>(), sources: {} };
    row.n += entry.n; row.tasks += entry.tasks; row.versions.add(entry.version || "?"); row.projects.add(names.get(entry.projectId) ?? entry.projectId);
    for (const [source, count] of Object.entries(entry.sources)) row.sources[source] = (row.sources[source] ?? 0) + count;
    today.set(entry.classKey, row);
  }
  const running = (db.prepare("SELECT harness_version AS v FROM lane_pilot_attempt WHERE harness_version IS NOT NULL AND created_at<=? ORDER BY created_at DESC LIMIT 1").get(until) as { v: string } | undefined)?.v;
  const selection = selectClasses({ classes, max: 3, walks: 2, recurrenceFloor: 3, openRepair: new Set(), roundsTonight: new Map(), roundsPerNight: 2, tokensLeft: 20_000_000, roundCost: 4_000_000,
    ...(running ? { runningVersion: running } : {}), seenVersions: classVersions(db, until - DAY) });
  const picked = new Map(selection.picked.map((row) => [row.classKey, row.why]));
  const skipped = new Map(selection.morning.map((row) => [row.classKey, row.why]));
  console.log(`\n=== ${label}  [${new Date(since).toISOString().slice(0, 16)} -> ${new Date(until).toISOString().slice(0, 16)}Z]  failures in real projects: ${entries.reduce((sum, row) => sum + row.n, 0)}, classes: ${today.size}`);
  const rows = classes.filter((row) => today.has(row.classKey)).sort((a, b) => today.get(b.classKey)!.n - today.get(a.classKey)!.n);
  for (const row of rows.slice(0, 14)) {
    const t = today.get(row.classKey)!;
    const verdict = picked.has(row.classKey) ? `PICK  (${picked.get(row.classKey)})` : `morning (${skipped.get(row.classKey) ?? "-"})`;
    console.log(`${pad(row.classKey, 22)} ${pad(row.origin, 12)} n=${String(t.n).padStart(3)} tasks=${String(t.tasks).padStart(3)}  ${row.counts[0]}/${row.windows[0]} ${row.counts[1]}/${row.windows[1]} ${row.counts[2]}/${row.windows[2]}  rung ${row.rung} ${row.state.padEnd(6)}  ${[...t.versions].join(",")}`);
    console.log(`    ${pad(row.reasonNorm, 110)}\n    projects: ${[...t.projects].slice(0, 3).join("; ")}  sources: ${JSON.stringify(t.sources)}\n    -> ${verdict}`);
  }
}

const nights = arg("nights");
if (nights) {
  const [from, to] = nights.split("..") as [string, string];
  for (let at = Date.parse(`${from}T03:00:00Z`); at <= Date.parse(`${to}T03:00:00Z`); at += DAY) report(`night ${nightOf(at - 1)} 03:00`, at - DAY, at);
}
const window = arg("window");
if (window) {
  const [from, to] = window.split("..") as [string, string];
  report(`window ${window}`, Date.parse(from), Date.parse(to));
}

if (process.argv.includes("--dry-run-now")) {
  const now = Number(arg("now") ?? (db.prepare("SELECT max(updated_at) AS t FROM lane_pilot_attempt").get() as { t: number }).t) + 1;
  const never = async () => { throw new Error("the dry run calls nothing outside the database"); };
  const ports: WallPorts = {
    now: () => now, version: arg("version") ?? "0.1.268",
    loadScope: async () => ({ isReal, scopeOf: (project) => (sandbox(project) ? (/bench/.test(names.get(project) ?? "") ? "bench" : "sandbox") : "real") }),
    logLines: logLinesIn, codeFiles: async () => [], reader: never as never, tellPm: never as never,
    repair: { view: never as never, report: never as never, tokens: never as never, busy: never as never, changedFiles: never as never, revert: never as never },
    release: { drill: async () => null, canary: async () => null },
    bench: { available: async () => false, ensureArm: never as never, compare: never as never, score: never as never },
    exam: async () => ({ exam: { items: [] } }), restart: never as never, deferrals: { open: never as never, close: never as never },
  };
  const wall = createWall({ db: db as never, kv: { get: async () => null, set: async () => undefined }, ports, log: console.log, hubDb: "/home/ubuntu/.bb/plugins/lane-pilot/data.db" });
  const summary = await wall.runNight({ dryRun: true, now });
  console.log(`\n=== dry-run night ${summary.night} (now = ${new Date(now).toISOString()}), nothing kept, no model called`);
  console.log(JSON.stringify({ classesSeen: summary.classesSeen, picked: summary.picked, hunts: summary.hunts, backlog: summary.backlog, stoppedBy: summary.stoppedBy, capTokens: summary.capTokens, benchRunnable: (summary as { plan?: { benchRunnable?: boolean } }).plan?.benchRunnable }, null, 2));
  console.log("morning list (not picked):");
  for (const row of summary.morning.slice(0, 12)) console.log(`  ${row.classKey}: ${row.why}`);
  console.log("kept in the copy after the dry run:", JSON.stringify(Object.fromEntries(["lane_pilot_wall_repair", "lane_pilot_wall_night", "lane_pilot_wall"].map((table) => [table, (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n]))));
}

// --rerun-class <key> [--head part,part]: the re-run plan of a class's failed attempts of the last 7 days on the receipts the hub holds.
const rerunClass = arg("rerun-class");
if (rerunClass) {
  const { planClassRerun } = await import("../src/rooms/wall/rerun");
  const head = (arg("head") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const now = Number(arg("now") ?? (db.prepare("SELECT max(updated_at) AS t FROM lane_pilot_attempt").get() as { t: number }).t) + 1;
  const plans = planClassRerun(db, { classKey: rerunClass, since: now - 7 * DAY, head: head as never, scopeOf: (project) => (sandbox(project) ? "sandbox" : "real"), limit: 500 });
  const tally = new Map<string, number>();
  for (const plan of plans) tally.set(`${plan.scope} from ${plan.affected.from ?? "none"} (${plan.affected.mode}), failed in ${plan.failedStage ?? "?"}`, (tally.get(`${plan.scope} from ${plan.affected.from ?? "none"} (${plan.affected.mode}), failed in ${plan.failedStage ?? "?"}`) ?? 0) + 1);
  console.log(`\n=== re-run plan of ${rerunClass}${head.length ? ` on head ${head.join("+")}` : ""}: ${plans.length} failed attempts`);
  for (const [line, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} x ${line}`);
  const sample = plans[0];
  if (sample) console.log(`  e.g. ${sample.taskId}: reused [${sample.affected.reused.join(", ")}], stale [${sample.affected.stale.map((row) => `${row.stage}: ${row.why}`).join("; ")}]`);
}
