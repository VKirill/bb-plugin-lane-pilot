import { scheduleIsolated, type ServerCore } from "../../core/server";
import { postOwnerItem } from "../../owner-waiting";
import { BEAT_KEY, gapOutage } from "../logic";
import { insertOutage, listOutages } from "../store";

/** Why the last run of the plugin ended, written at dispose (a reload, a deploy); none means it died without saying (A death gets its name). */
export const STOP_KEY = "lp.stop";
/** This run of the plugin: when it started, on which version, in which process (Process record). */
export const PROCESS_KEY = "lp.process";

/** At start: an old beat is an outage on record, named by how the last run ended, and the risen plugin says so on «Ждут владельца». */
export async function recordStartGap(ctx: Pick<ServerCore, "bb" | "db" | "log">, now = Date.now()) {
  const kv = ctx.bb.storage.kv;
  const last = await kv.get(BEAT_KEY).catch(() => null) as number | null;
  const stop = await kv.get(STOP_KEY).catch(() => null) as { reason?: string; at?: number } | null;
  const outage = gapOutage(typeof last === "number" ? last : null, now);
  if (outage) {
    const cause = stop?.reason && typeof stop.at === "number" && Math.abs(stop.at - outage.fromAt) < 10 * 60_000 ? stop.reason : "died without a word: a crash, a hang or the machine went down";
    insertOutage(ctx.db, outage, cause, now);
    ctx.log(`outage: Lane Pilot was not running for ${outage.minutes} min (last beat ${new Date(outage.fromAt).toISOString()}): ${cause}`);
    // The risen daemon speaks: one row for the owner (the Telegram digest carries it), not a wake-up in the night.
    try {
      postOwnerItem(ctx.db as never, { key: `outage:${outage.fromAt}`, source: "outage", kind: "outage", wake: false,
        what: `Lane Pilot was down ${outage.minutes} min (${new Date(outage.fromAt).toISOString().slice(0, 16)}–${new Date(outage.toAt).toISOString().slice(11, 16)} UTC)`, why: cause });
    } catch { /* the owner-waiting table may not exist in a test database */ }
  }
  await kv.set(BEAT_KEY, now as never).catch(() => undefined);
  await kv.set(STOP_KEY, null as never).catch(() => undefined);
  await kv.set(PROCESS_KEY, { startedAt: now, pid: process.pid, node: process.version } as never).catch(() => undefined);
  // Prune foreign memory previews: probe rows older than 30 days (planted tokens and their answers) leave at boot.
  try { ctx.db.prepare("DELETE FROM lane_pilot_memory_probe WHERE at < ?").run(now - 30 * 86_400_000); } catch { /* no probe table in a test database */ }
  return outage;
}

/** The start's gap check, then one beat a minute. */
export async function mountOutage(ctx: ServerCore): Promise<void> {
  await recordStartGap(ctx);
  // The last words of this run: a reload or a deploy names itself, so the next start does not count it as a death.
  ctx.bb.onDispose(() => { void ctx.bb.storage.kv.set(STOP_KEY, { reason: "the plugin was reloaded (a deploy or a settings change)", at: Date.now() } as never).catch(() => undefined); });
  scheduleIsolated(ctx.bb, "outage-beat", "* * * * *", async () => {
    if (ctx.isDisposed()) return;
    await ctx.bb.storage.kv.set(BEAT_KEY, Date.now() as never).catch(() => undefined);
  }, { timeoutMs: 30_000 });
}

export const OUTAGE_USAGE = "bb lane-pilot outages [--days 7]   (the gaps of more than 5 minutes when Lane Pilot was not running)";
export function runOutageCli(ctx: Pick<ServerCore, "db">, argv: readonly string[], now = Date.now()): { exitCode: number; stdout?: string; stderr?: string } {
  const days = argv[0] === "--days" && argv[1] ? Number(argv[1]) : argv.length ? NaN : 7;
  if (!Number.isInteger(days) || days < 1 || days > 365) return { exitCode: 1, stderr: OUTAGE_USAGE };
  return { exitCode: 0, stdout: JSON.stringify(listOutages(ctx.db, now - days * 86_400_000), null, 2) };
}
