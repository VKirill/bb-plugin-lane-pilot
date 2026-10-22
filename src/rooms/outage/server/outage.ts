import { scheduleIsolated, type ServerCore } from "../../core/server";
import { BEAT_KEY, gapOutage } from "../logic";
import { insertOutage, listOutages } from "../store";

/** At start: an old beat is an outage on record, and the beat is now. Returns the outage written, if any. */
export async function recordStartGap(ctx: Pick<ServerCore, "bb" | "db" | "log">, now = Date.now()) {
  const kv = ctx.bb.storage.kv;
  const last = await kv.get(BEAT_KEY).catch(() => null) as number | null;
  const outage = gapOutage(typeof last === "number" ? last : null, now);
  if (outage) {
    insertOutage(ctx.db, outage, null, now);
    ctx.log(`outage: Lane Pilot was not running for ${outage.minutes} min (last beat ${new Date(outage.fromAt).toISOString()})`);
  }
  await kv.set(BEAT_KEY, now as never).catch(() => undefined);
  return outage;
}

/** The start's gap check, then one beat a minute. */
export async function mountOutage(ctx: ServerCore): Promise<void> {
  await recordStartGap(ctx);
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
