// Public API of reports/server: the two Telegram schedules of the owner's topic (they were hub scripts) and their pure parts.
import { scheduleIsolated } from "../../platform/server";
import type { ServerCore } from "../../contracts/server";
import { loadPushConfig, readOwnerConfigKey, writeOwnerConfigKey } from "../../owner-waiting/server";
import { buildDailyReport, dailyDue } from "./daily";
import { runOwnerPush, type DigestLike } from "./owner-push";
import { runSqliteChild, type SqlRun } from "./sql-runner";
import { createTelegramSender, type TelegramSend } from "./telegram";

export { buildDailyReport, composeDailyReport, dailyDue, localDayHour } from "./daily";
export { runOwnerPush } from "./owner-push";
export { splitSql, runSqliteChild } from "./sql-runner";
export { createTelegramSender, TelegramNotReadyError, TelegramSendError, TG_CHAT_NAME, TG_TOKEN_NAME, TG_TOPIC_NAME } from "./telegram";

/** The last local day the daily report went out (lane_pilot_owner_config, the owner-waiting room's own key/value table). */
export const DAILY_SENT_KEY = "daily_sent_day";
/** A dry run has its own day mark, so it logs the text once a day and never hides the real send. */
export const DAILY_DRY_KEY = "daily_dry_day";
const DAILY_CRON = "0 * * * *";
const PUSH_CRON = "*/30 * * * *";

export type ReportsDeps = {
  /** owner_waiting_digest / owner_waiting_ack of the RPC (ownerWaitingRpc), so the webhook events of a digest stay the same. */
  digest: () => Promise<DigestLike>;
  ack: (keys: string[]) => unknown;
  /** The BB core database file; the hub's `~/.bb/bb.db` by default. */
  coreFile: string;
  send?: TelegramSend;
  run?: SqlRun;
};

/** «Ждут владельца» every 30 minutes and the daily report at 09:00 in the owner's time zone, both to the Telegram topic from Env Catalog. */
export function mountReports(ctx: ServerCore, deps: ReportsDeps): void {
  const send = deps.send ?? createTelegramSender({ secrets: ctx.secrets });
  const dryRun = () => loadPushConfig(ctx.db).dryRun === true;

  scheduleIsolated(ctx.bb, "owner-push", PUSH_CRON, async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    try { await runOwnerPush({ digest: deps.digest, ack: deps.ack, send, dryRun, log: ctx.log }); }
    catch (cause) { ctx.log(`owner push failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }, { timeoutMs: 120_000 });

  scheduleIsolated(ctx.bb, "daily-report", DAILY_CRON, async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const now = Date.now();
    const { timezone } = loadPushConfig(ctx.db);
    const markKey = dryRun() ? DAILY_DRY_KEY : DAILY_SENT_KEY;
    const due = dailyDue(now, timezone, readOwnerConfigKey(ctx.db, markKey));
    if (!due.due) return;
    try {
      const text = await buildDailyReport({ db: ctx.db, dataFile: ctx.db.name, coreFile: deps.coreFile, run: deps.run ?? runSqliteChild, now: () => now });
      if (dryRun()) { ctx.log(`daily report (dry run, not sent):\n${text}`); writeOwnerConfigKey(ctx.db, markKey, due.day, now); return; }
      await send(text);
      writeOwnerConfigKey(ctx.db, markKey, due.day, now);
    } catch (cause) { ctx.log(`daily report not sent (${cause instanceof Error ? cause.message : String(cause)}); the next tick tries again`); }
  }, { timeoutMs: 180_000 });
}
