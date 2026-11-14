// What the region scene sma_r12.py cannot ask in Python: the supervisor's TypeScript pieces, run for real on scratch folders (no model, no hub write).
// Prints one JSON line: the worker grants and their ledger, the terminal journal and its report, the plugin database opened twice.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { journalAppend, outsideWorkSummary } from "../../../src/rooms/owner-presence/logic";
import { openDatabase } from "../../../src/rooms/plugin-db";
import { grantCommands, grantRunFolders } from "../../../src/rooms/verification/worker-user";

async function grants() {
  const dir = "/tmp/lp-run-only";
  const only = ["linux", "darwin"].map((platform) => grantCommands(platform, "lp-worker", "owner", dir).every((step) => step.args.includes(dir) && step.args.filter((arg) => arg.startsWith("/")).length === 1 && step.args.filter((arg) => arg.startsWith("/"))[0] === dir));
  const hasSetfacl = spawnSync("sh", ["-c", "command -v setfacl"]).status === 0;
  if (!hasSetfacl) return { onlyTheFolder: only, ledger: null };
  const home = mkdtempSync(join(tmpdir(), "lp-r12-home-"));
  const good = mkdtempSync(join(tmpdir(), "lp-r12-run-"));
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const user = userInfo().username;
    const granted = await grantRunFolders(user, [good, join(good, "no", "such", "folder")], "linux");
    const rows = readFileSync(join(home, ".lane-pilot", "worker-grants.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { user: string; owner: string; path: string; at: number });
    return { onlyTheFolder: only, ledger: { grantedIsGood: granted.length === 1 && granted[0] === good, rows: rows.length, rowIsGood: rows[0]?.path === good && rows[0]?.user === user && rows[0]?.owner === user && typeof rows[0]?.at === "number" } };
  } finally {
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
    rmSync(home, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  }
}

function journal() {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const mark = { threadId: "thr_a", providerId: "codex", hostId: "h_mini", at: Date.parse("2026-11-11T09:00:00Z") };
  const one = journalAppend([], mark, now);
  const same = journalAppend(one, { ...mark, at: Date.parse("2026-11-11T18:00:00Z") }, now);
  const other = journalAppend(same, { ...mark, threadId: "thr_b" }, now);
  const old = journalAppend(other, { ...mark, threadId: "thr_old", at: now - 91 * 86_400_000 }, now);
  let rows: ReturnType<typeof journalAppend> = [];
  for (const [i, day] of ["2026-11-05", "2026-11-08", "2026-11-10"].entries()) rows = journalAppend(rows, { threadId: `thr_${i}`, providerId: "codex", hostId: "h", at: Date.parse(`${day}T10:00:00Z`) }, now);
  const summary = outsideWorkSummary(rows, now, 10);
  return { one: one.length, same: same.length, other: other.length, oldDropped: !old.some((row) => row.threadId === "thr_old") && old.length === 2, summary: { days: summary.days, windowDays: summary.windowDays, attempts: summary.attempts, share: summary.share }, empty: outsideWorkSummary([], now, 10).days };
}

function database() {
  const host = createFakePluginHost({ pluginId: "lane-pilot" });
  const tables = (db: ReturnType<typeof openDatabase>) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
  const first = openDatabase(host.bb);
  const created = tables(first).includes("lane_pilot_run");
  first.prepare("INSERT INTO lane_pilot_run (id, project_id, state, created_at, updated_at) VALUES ('r_exists', 'p', 'pending', 1, 1)").run();
  let threw = false;
  let second: ReturnType<typeof openDatabase> | undefined;
  try { second = openDatabase(host.bb); } catch { threw = true; }
  const kept = second ? (second.prepare("SELECT count(*) AS n FROM lane_pilot_run WHERE id = 'r_exists'").get() as { n: number }).n : -1;
  return { created, threw, kept };
}

process.stdout.write(`${JSON.stringify({ grants: await grants(), journal: journal(), database: database() })}\n`); // the probe's one result line
