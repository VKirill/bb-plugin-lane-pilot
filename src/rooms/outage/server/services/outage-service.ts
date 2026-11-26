import { bestEffort } from "@lane-pilot/kit";
import { pruneMemoryProbeBefore } from "@lane-pilot/memory-core";
import type { ServerCore } from "../../../contracts/server";
import { BEAT_KEY, gapOutage, type OutageRecord } from "../../models/outage";
import { insertOutage, listOutages } from "../repositories/outage-repository";

/** Why the last run of the plugin ended, written at dispose (a reload, a deploy); none means it died without saying (A death gets its name). */
export const STOP_KEY = "lp.stop";
/** This run of the plugin: when it started, on which version, in which process (Process record). */
export const PROCESS_KEY = "lp.process";

/** At start: an old beat is an outage on record, named by how the last run ended, and the risen plugin says so on «Ждут владельца». */
export async function recordStartGap(ctx: Pick<ServerCore, "bb" | "db" | "log">, now = Date.now()) {
  const kv = ctx.bb.storage.kv;
  // The gap reads are best-effort: a store hiccup must not keep the heartbeat below from being scheduled.
  const last = await bestEffort(ctx.log, "outage last beat read", kv.get(BEAT_KEY) as Promise<number | null>, null);
  const stop = await bestEffort(ctx.log, "outage stop record read", kv.get(STOP_KEY) as Promise<{ reason?: string; at?: number } | null>, null);
  const outage = gapOutage(typeof last === "number" ? last : null, now);
  if (outage) {
    const cause = stop?.reason && typeof stop.at === "number" && Math.abs(stop.at - outage.fromAt) < 10 * 60_000 ? stop.reason : "остановился без предупреждения: сбой, зависание или машина выключилась";
    insertOutage(ctx.db, outage, cause, now);
    // A fact, not a decision: the journal (`lane_pilot_outage`, `bb lane-pilot outages`) and the log keep it; the owner's list
    // holds only what asks him (2026-11-02: «Ждут владельца» carried a «не работал 5 мин» row that wanted nothing).
    ctx.log(`outage: Lane Pilot was not running for ${outage.minutes} min (last beat ${new Date(outage.fromAt).toISOString()}): ${cause}`);
  }
  await bestEffort(ctx.log, "outage beat write", kv.set(BEAT_KEY, now as never), undefined);
  await bestEffort(ctx.log, "outage stop-marker clear", kv.set(STOP_KEY, null as never), undefined);
  await bestEffort(ctx.log, "outage process record", kv.set(PROCESS_KEY, { startedAt: now, pid: process.pid, node: process.version } as never), undefined);
  // Prune foreign memory previews: probe rows older than 30 days (planted tokens and their answers) leave at boot.
  try { pruneMemoryProbeBefore(ctx.db, now - 30 * 86_400_000); } catch { /* no probe table in a test database */ }
  return outage;
}

/** Records a graceful stop reason at dispose so the next startup does not classify a reload/deploy as a crash. */
export async function markReloadStop(ctx: Pick<ServerCore, "bb" | "log">, at = Date.now()): Promise<void> {
  await bestEffort(ctx.log, "outage stop marker", ctx.bb.storage.kv.set(STOP_KEY, { reason: "the plugin was reloaded (a deploy or a settings change)", at } as never), undefined);
}

/** One heartbeat; called at every tick of the engine clock (at least once a minute). */
export async function stampBeat(ctx: Pick<ServerCore, "bb" | "log">, at = Date.now()): Promise<void> {
  await bestEffort(ctx.log, "outage heartbeat", ctx.bb.storage.kv.set(BEAT_KEY, at as never), undefined);
}

/** Lists outage rows recorded within the last `days` days relative to `now`. */
export function listRecentOutages(db: Pick<ServerCore["db"], "prepare">, days: number, now = Date.now()): OutageRecord[] {
  return listOutages(db, now - days * 86_400_000);
}
