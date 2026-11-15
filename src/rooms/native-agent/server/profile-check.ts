import { scheduleIsolated } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";
import { closeOwnerItem, postOwnerItem } from "../../owner-waiting";
import {
  PROFILE_CHECK_WINDOW_MS,
  buildProfileReport,
  helperThreadsViaSdk,
  profileCheckMorningLine,
  saveProfileCheck,
  type HelperThreadRow,
  type ProfileReport,
} from "../profile-check";

/**
 * The daily run of the profile check (the logic lives in ../profile-check.ts). The helper threads and their stored
 * policies are core facts read through the SDK (`threads.list` + `experimental_listPluginMetadata`) — the plugin
 * never opens BB's `bb.db` itself (a second SQLite copy in this process once killed the hub with SIGBUS). A BB whose
 * SDK cannot serve the read makes the day «не проверено», not red. The report row feeds the morning line, and a loss
 * becomes one row on the owner's list (never a PM message, like every other red fact); the row closes itself the
 * first day the check goes green again.
 */
export const PROFILE_CHECK_OWNER_KEY = "profile-check";
export const PROFILE_CHECK_SCHEDULE = "profile-check-daily";

export function createProfileCheck(ctx: ServerCore) {
  const { db, bb } = ctx;

  /** The report with the red list; a core read the SDK cannot serve is «не проверено», not red. */
  async function check(now: number = Date.now()): Promise<ProfileReport> {
    const since = now - PROFILE_CHECK_WINDOW_MS;
    let threads: HelperThreadRow[];
    let coreMissing: string | null = null;
    try {
      threads = await helperThreadsViaSdk(bb, since);
    } catch (cause) {
      threads = [];
      // A read the SDK cannot serve makes the day unknown, not red: one log line and «не проверено» in the
      // morning line — no owner item, a stale red row stays untouched.
      coreMissing = cause instanceof Error ? cause.message : String(cause);
    }
    const agents = (bb as { agents?: { experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {};
    const report = buildProfileReport({ threads, agents, now });
    if (coreMissing) {
      // Unverified is the whole verdict: findings computed over an empty thread substitute would be noise, not signal.
      report.unverified = coreMissing.slice(0, 300);
      report.red = [];
    }
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
