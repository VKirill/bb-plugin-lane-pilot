import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scheduleIsolated } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";
import { closeOwnerItem, postOwnerItem } from "../../owner-waiting";
import {
  PROFILE_CHECK_WINDOW_MS,
  buildProfileReport,
  helperThreads,
  profileCheckMorningLine,
  saveProfileCheck,
  type ProfileReport,
} from "../profile-check";

/**
 * The daily run of the profile check (the logic lives in ../profile-check.ts). It opens BB's own database read-only —
 * `threads` and `thread_plugin_metadata` are the core's, not Lane Pilot's — asks `bb.agents` for the live advertisement,
 * writes the report row the morning line reads, and turns a loss into one row on the owner's list (never a PM message,
 * like every other red fact). The row closes itself the first day the check goes green again.
 */
export const PROFILE_CHECK_OWNER_KEY = "profile-check";
export const PROFILE_CHECK_SCHEDULE = "profile-check-daily";
export const PROFILE_CHECK_CORE_DB = process.env.LANE_PILOT_CORE_DB ?? join(homedir(), ".bb", "bb.db");

export function createProfileCheck(ctx: ServerCore) {
  const { db, bb } = ctx;

  /** The report with the red list; `corePath` is injectable so the test needs no hub. */
  function check(now: number = Date.now(), corePath: string = PROFILE_CHECK_CORE_DB): ProfileReport {
    const since = now - PROFILE_CHECK_WINDOW_MS;
    let threads: ReturnType<typeof helperThreads>;
    let coreMissing: string | null = null;
    try {
      const core = new DatabaseSync(corePath, { readOnly: true });
      try {
        core.exec("PRAGMA busy_timeout = 5000");
        threads = helperThreads(core as never, since);
      } finally {
        core.close();
      }
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
    await Promise.resolve().then(() => api.check()).catch((cause: unknown) => ctx.log(`profile-check failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 10 * 60_000 });
}
