import type Database from "better-sqlite3";
import {
  BELL_PREFIX,
  BELL_SEEDED,
  OWNER_BELL_DAILY_CAP,
  REPEAT_AFTER_MS,
  formatDigestText,
  inQuietHours,
  localStartOfDayMs,
  nextDigestWindow,
  quietHoursEnd,
  type BellNotice,
  type Digest,
  type PlanBellOptions,
} from "../../models/push-config";
import {
  countBellPushedSince,
  deleteBellPushedBefore,
  hasAnyBellPush,
  hasOwnerConfigKey,
  insertIgnoreOwnerConfigKey,
  insertIgnoreOwnerPush,
  listOwnerPushKeys,
  listOwnerPushRows,
} from "../repositories/owner-push-repository";
import { loadPushConfig, readOwnerConfigKey, savePushConfig, writeOwnerConfigKey } from "./owner-config-service";
import { collectOwnerWaiting, type OwnerItemSweep } from "./owner-items-service";

export { loadPushConfig, readOwnerConfigKey, savePushConfig, writeOwnerConfigKey };

type Db = Pick<Database.Database, "prepare" | "transaction">;

/** What to send now. `keys` are all the new wake items, also the ones only counted: the caller acknowledges them after a successful send. */
export function planDigest(db: Db, now: number = Date.now(), sweeps: readonly OwnerItemSweep[] = []): Digest {
  const config = loadPushConfig(db);
  const none = (reason: Digest["reason"]): Digest => ({ send: false, reason, text: "", keys: [], shown: 0, more: 0 });
  if (!config.enabled) return none("disabled");
  if (inQuietHours(now, config.quiet, config.timezone)) return none("quiet_hours");
  const pushedAt = new Map(listOwnerPushRows(db).map((row) => [row.key, row.pushed_at]));
  // Only a «now» row may push: a «later» one waits its turn on the screen (NOW_CAP, models/owner-item.ts).
  const open = collectOwnerWaiting(db, now, sweeps).items.filter((item) => item.wake && item.tier === "now");
  // Repeat after six hours: an item still open six hours after its push is said once more (key «…#again»), never a third time.
  const again = open.filter((item) => (pushedAt.get(item.key) ?? now) <= now - REPEAT_AFTER_MS && !pushedAt.has(`${item.key}#again`));
  const fresh = [...open.filter((item) => !pushedAt.has(item.key)), ...again.map((item) => ({ ...item, key: `${item.key}#again`, what: `(ещё ждёт, 6 ч) ${item.what}` }))];
  if (!fresh.length) return none("nothing_new");
  const { text, shown, more } = formatDigestText(fresh);
  return { send: true, reason: null, text, keys: fresh.map((item) => item.key), shown, more };
}

/** The keys went out: they never push again. */
export function ackDigest(db: Db, keys: readonly string[], now: number = Date.now()): number {
  let added = 0;
  for (const key of keys) added += insertIgnoreOwnerPush(db, key, now);
  return added;
}

/** Counts individual bell notifications recorded since local midnight in the owner's timezone. */
export function bellPushedToday(db: Db, now: number, timezone: string): number {
  return countBellPushedSince(db, localStartOfDayMs(now, timezone));
}

/** Seeds pre-existing open wake items at startup with yesterday's timestamp so neither alerts flood nor today's cap is consumed. */
export function seedBell(db: Db, now: number = Date.now(), sweeps: readonly OwnerItemSweep[] = []): void {
  if (hasOwnerConfigKey(db, BELL_SEEDED)) return;
  if (!hasAnyBellPush(db)) {
    const yesterday = now - 86_400_000;
    for (const item of collectOwnerWaiting(db, now, sweeps).items.filter((item) => item.wake && item.tier === "now")) {
      insertIgnoreOwnerPush(db, `${BELL_PREFIX}${item.key}`, yesterday);
    }
  }
  insertIgnoreOwnerConfigKey(db, BELL_SEEDED, "1", now);
}

/** The browser bell's notice: one count line for the wake items not yet announced, obeying enabled, quiet-hours wait, and daily cap. */
export function planBellNotice(db: Db, now: number = Date.now(), sweeps: readonly OwnerItemSweep[] = [], options: PlanBellOptions = {}): BellNotice {
  const config = loadPushConfig(db);
  const none = (reason: BellNotice["reason"], waitUntil?: number): BellNotice => ({
    send: false,
    reason,
    title: "",
    text: "",
    keys: [],
    ...(waitUntil === undefined ? {} : { waitUntil }),
  });
  if (config.bell === false || !config.enabled) return none("disabled");
  // The marks of the bell are kept a month: an item that old is no longer «new» to anyone, and the table stays small.
  deleteBellPushedBefore(db, now - 30 * 86_400_000);
  const announced = new Set(listOwnerPushKeys(db));
  const items = collectOwnerWaiting(db, now, sweeps).items;
  const unannouncedWake = items.filter((item) => item.wake && !announced.has(`${BELL_PREFIX}${item.key}`) && !announced.has(item.key));
  if (!unannouncedWake.length) return none("nothing_new");
  const quietEnd = quietHoursEnd(now, config.quiet, config.timezone);
  if (quietEnd !== null) return none("quiet_hours", quietEnd);
  if (!options.bypassDailyCap && bellPushedToday(db, now, config.timezone) >= OWNER_BELL_DAILY_CAP) {
    return none("daily_cap", nextDigestWindow(now, config.quiet, config.timezone));
  }
  const fresh = options.includeLater ? unannouncedWake : unannouncedWake.filter((item) => item.tier === "now");
  if (!fresh.length) return none("nothing_new");
  return { send: true, reason: null, title: `Lane Pilot: ждёт решения — ${fresh.length}`, text: `${fresh.length} — на экране «Ждут владельца».`, keys: fresh.map((item) => `${BELL_PREFIX}${item.key}`) };
}
