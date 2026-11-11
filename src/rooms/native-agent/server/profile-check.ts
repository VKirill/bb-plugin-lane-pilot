import { homedir } from "node:os";
import { join } from "node:path";
import { spawnAsync } from "@lane-pilot/kit";
import { scheduleIsolated } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";
import { closeOwnerItem, postOwnerItem } from "../../owner-waiting";
import {
  PROFILE_CHECK_WINDOW_MS,
  buildProfileReport,
  helperThreadsVia,
  profileCheckMorningLine,
  saveProfileCheck,
  type CoreRead,
  type HelperThreadRow,
  type ProfileReport,
} from "../profile-check";

/**
 * The daily run of the profile check (the logic lives in ../profile-check.ts). It reads BB's own database from a child
 * process — `threads` and `thread_plugin_metadata` are the core's, not Lane Pilot's — asks `bb.agents` for the live advertisement,
 * writes the report row the morning line reads, and turns a loss into one row on the owner's list (never a PM message,
 * like every other red fact). The row closes itself the first day the check goes green again.
 */
export const PROFILE_CHECK_OWNER_KEY = "profile-check";
export const PROFILE_CHECK_SCHEDULE = "profile-check-daily";
export const PROFILE_CHECK_CORE_DB = process.env.LANE_PILOT_CORE_DB ?? join(homedir(), ".bb", "bb.db");

/**
 * One read-only query of BB's database, run in a child process. BB holds `bb.db` with its own SQLite (better-sqlite3);
 * a second SQLite copy in the same process (`node:sqlite`) that opens the file sees no foreign lock on it, truncates the
 * `-shm` file under BB's mapping and drops BB's file locks when it closes. That killed the hub with SIGBUS once a day,
 * 2026-11-07…11. Between two processes the locks hold, so the read lives in its own process.
 */
const CORE_READER = `const { DatabaseSync } = require("node:sqlite");
const [file, method, sql, params] = process.argv.slice(1);
let out;
try {
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 5000"); out = { rows: db.prepare(sql)[method](...JSON.parse(params)) ?? null }; } finally { db.close(); }
} catch (error) { out = { error: String((error && error.message) || error) }; }
process.stdout.write(JSON.stringify(out));`;

export function coreRead(file: string): CoreRead {
  return async (method, sql, params) => {
    const run = await spawnAsync(process.execPath, ["-e", CORE_READER, file, method, sql, JSON.stringify(params)], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (run.error || run.status !== 0) throw new Error(run.error?.message ?? `the reader of the core base exited ${run.status}: ${run.stderr.slice(-300)}`);
    const out = JSON.parse(run.stdout) as { rows?: unknown; error?: string };
    if (out.error) throw new Error(out.error);
    return out.rows ?? undefined;
  };
}

export function createProfileCheck(ctx: ServerCore) {
  const { db, bb } = ctx;

  /** The report with the red list; `corePath` is injectable so the test needs no hub. */
  async function check(now: number = Date.now(), corePath: string = PROFILE_CHECK_CORE_DB): Promise<ProfileReport> {
    const since = now - PROFILE_CHECK_WINDOW_MS;
    let threads: HelperThreadRow[];
    let coreMissing: string | null = null;
    try {
      threads = await helperThreadsVia(coreRead(corePath), since);
    } catch (cause) {
      threads = [];
      // A base the check cannot read makes the day unknown, not red (plugin off the DB machine, file missing):
      // one log line and «не проверено» in the morning line — no owner item, a stale red row stays untouched.
      coreMissing = cause instanceof Error ? cause.message : String(cause);
    }
    const agents = (bb as { agents?: { experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {};
    const report = buildProfileReport({ threads, agents, now });
    if (coreMissing) report.unverified = coreMissing.slice(0, 300);
    saveProfileCheck(db as never, report);
    if (report.unverified) {
      ctx.log(`profile-check: unverified (${report.unverified})`);
      return report;
    }
    if (report.red.length) {
      postOwnerItem(db as never, {
        key: PROFILE_CHECK_OWNER_KEY,
        source: "night",
        kind: "profile_red",
        projectId: null,
        wake: false,
        what: `Профили ролей: ${report.red.length} красных (${report.red[0]!.slice(0, 160)}${report.red.length > 1 ? "…" : ""})`,
        why: report.red.join("\n").slice(0, 590),
        evidence: [{ kind: "note", ref: "bb lane-pilot wall morning", label: "проверка профилей" }],
      }, now);
    } else {
      closeOwnerItem(db as never, PROFILE_CHECK_OWNER_KEY, "profile-check:green", now);
    }
    ctx.log(`profile-check: ${report.red.length ? `RED ${report.red.length} (${report.red.join("; ").slice(0, 300)})` : `green (${report.threads} threads)`}`);
    return report;
  }

  return { profileCheck: { check } };
}
export type ProfileCheckApi = ReturnType<typeof createProfileCheck>["profileCheck"];

export { profileCheckMorningLine };

export function mountProfileCheck(ctx: ServerCore, api: ProfileCheckApi): void {
  // 04:52, after the night repairs (03:25) and before the 09:00 report: the day knows its loss by breakfast.
  scheduleIsolated(ctx.bb, PROFILE_CHECK_SCHEDULE, "52 4 * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.check().catch((cause: unknown) => ctx.log(`profile-check failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 10 * 60_000 });
}
