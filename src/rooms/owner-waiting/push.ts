import type Database from "better-sqlite3";
import { hubFields, writeHubFields } from "../improvement";
import { collectOwnerWaiting, type OwnerItem } from "./items";

/**
 * The Telegram side of «waiting for the owner». Lane Pilot has no Telegram sender of its own: the hub's script (scripts/lp-owner-push.sh)
 * asks `digest`, sends the text it returns with the same bot as the daily report, and then tells `ack` which keys went out. The decisions
 * live here, in code, and are tested:
 *  - only `wake` items push (an overdue deferral, a memory conflict, whatever the night loop posts with wake); the rest wait on the screen
 *    and in the daily report;
 *  - one waiting, one message: a key that was acknowledged never pushes again (the daily report is the reminder);
 *  - quiet hours (default 23:00–08:00 Europe/Madrid, a setting): nothing is sent, nothing is lost; the items go out in the first digest after;
 *  - a failed send is not acknowledged, so the next tick tries again.
 */
type Db = Pick<Database.Database, "prepare" | "transaction">;

export type PushConfig = { enabled: boolean; quiet: string; timezone: string };
export const DEFAULT_PUSH_CONFIG: PushConfig = { enabled: true, quiet: "23:00-08:00", timezone: "Europe/Madrid" };
export const PUSH_CONFIG_KEYS = ["enabled", "quiet", "timezone"] as const;
/** At most this many items are named in one message; the rest are counted. */
export const DIGEST_LINES = 6;

const QUIET = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

function validTimezone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: zone }); return true; } catch { return false; }
}

export function loadPushConfig(db: Db): PushConfig {
  const rows = db.prepare("SELECT key, value FROM lane_pilot_owner_config").all() as Array<{ key: string; value: string }>;
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const old: PushConfig = {
    enabled: stored.enabled === undefined ? DEFAULT_PUSH_CONFIG.enabled : stored.enabled === "on",
    quiet: stored.quiet && QUIET.test(stored.quiet) ? stored.quiet : DEFAULT_PUSH_CONFIG.quiet,
    timezone: stored.timezone && validTimezone(stored.timezone) ? stored.timezone : DEFAULT_PUSH_CONFIG.timezone,
  };
  // A global row (`owner_push.*`, written by the screen and by this command) wins over the old table, which stays as the fallback.
  const own = hubFields(db, "owner_push") as Partial<PushConfig>;
  return { enabled: own.enabled ?? old.enabled, quiet: own.quiet ?? old.quiet, timezone: own.timezone ?? old.timezone };
}

/** `enabled` on|off, `quiet` HH:MM-HH:MM ("" turns quiet hours off as 00:00-00:00), `timezone` an IANA name. A wrong value is refused with what is accepted. */
export function savePushConfig(db: Db, patch: Record<string, string | undefined>, now: number = Date.now()): PushConfig {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "enabled" && value !== "on" && value !== "off") throw new Error("enabled is on or off");
    if (key === "quiet" && !QUIET.test(value)) throw new Error("quiet is HH:MM-HH:MM in the time zone (23:00-08:00; 00:00-00:00 means no quiet hours)");
    if (key === "timezone" && !validTimezone(value)) throw new Error(`unknown time zone «${value}» (an IANA name such as Europe/Madrid)`);
    if (!(PUSH_CONFIG_KEYS as readonly string[]).includes(key)) throw new Error(`unknown setting «${key}» (${PUSH_CONFIG_KEYS.join(", ")})`);
    fields[key] = key === "enabled" ? value === "on" : value;
  }
  writeHubFields(db, "owner_push", fields, now);
  return loadPushConfig(db);
}

/** Minutes since local midnight in `timezone`. */
function localMinutes(now: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  return part("hour") * 60 + part("minute");
}

/** Whether `now` falls in the quiet window; a window that wraps midnight (23:00-08:00) is one window; equal ends mean none. */
export function inQuietHours(now: number, quiet: string, timezone: string): boolean {
  const match = QUIET.exec(quiet);
  if (!match) return false;
  const from = Number(match[1]) * 60 + Number(match[2]), to = Number(match[3]) * 60 + Number(match[4]);
  if (from === to) return false;
  const at = localMinutes(now, timezone);
  return from < to ? at >= from && at < to : at >= from || at < to;
}

const LABEL: Record<string, string> = { deferral_overdue: "просрочена отсрочка", memory_conflict: "конфликт памяти", night: "ночь", wall: "стена", backlog: "бэклог", rule_proposal: "правило", learning: "обучение", deferral_term: "нужен срок" };
const REASON_LABEL: Record<string, string> = { decision: "решение", blocked: "стоит", red: "красное", term: "срок" };
const line = (item: OwnerItem) => `• ${LABEL[item.source] ?? item.source} [${REASON_LABEL[callReason(item.kind)]}]: ${item.what.replace(/\s+/g, " ").slice(0, 110)}`;

/** An open item is said again once, this long after its first push. */
export const REPEAT_AFTER_MS = 6 * 3_600_000;

/** The four reasons a person is called (SMA: Four reasons to call): a decision only they make, work that cannot go on, something red, a term that ends. */
export const CALL_REASONS = ["decision", "blocked", "red", "term"] as const;
export type CallReason = (typeof CALL_REASONS)[number];
export function callReason(kind: string): CallReason {
  if (/canary|regress|red|outage/.test(kind)) return "red";
  if (/deferral|term|deadline|expire/.test(kind)) return "term";
  if (/wall|blocked|stuck|needs_human|stall/.test(kind)) return "blocked";
  return "decision";
}

export type Digest = { send: boolean; reason: "disabled" | "quiet_hours" | "nothing_new" | null; text: string; keys: string[]; shown: number; more: number };

/** What to send now. `keys` are all the new wake items, also the ones only counted: the caller acknowledges them after a successful send. */
export function planDigest(db: Db, now: number = Date.now()): Digest {
  const config = loadPushConfig(db);
  const none = (reason: Digest["reason"]): Digest => ({ send: false, reason, text: "", keys: [], shown: 0, more: 0 });
  if (!config.enabled) return none("disabled");
  if (inQuietHours(now, config.quiet, config.timezone)) return none("quiet_hours");
  const pushedAt = new Map((db.prepare("SELECT key, pushed_at FROM lane_pilot_owner_push").all() as Array<{ key: string; pushed_at: number }>).map((row) => [row.key, row.pushed_at]));
  const open = collectOwnerWaiting(db, now).items.filter((item) => item.wake);
  // Repeat after six hours: an item still open six hours after its push is said once more (key «…#again»), never a third time.
  const again = open.filter((item) => (pushedAt.get(item.key) ?? now) <= now - REPEAT_AFTER_MS && !pushedAt.has(`${item.key}#again`));
  const fresh = [...open.filter((item) => !pushedAt.has(item.key)), ...again.map((item) => ({ ...item, key: `${item.key}#again`, what: `(ещё ждёт, 6 ч) ${item.what}` }))];
  if (!fresh.length) return none("nothing_new");
  const shown = fresh.slice(0, DIGEST_LINES);
  const more = fresh.length - shown.length;
  const text = [
    `Lane Pilot: ждут владельца, новых — ${fresh.length}.`,
    ...shown.map(line),
    ...(more ? [`…и ещё ${more}.`] : []),
    "Что, почему и точное действие — на экране «Ждут владельца» (Lane Pilot → Система) или `bb lane-pilot waiting`. Ждать ответа ничего не будет.",
  ].join("\n");
  return { send: true, reason: null, text, keys: fresh.map((item) => item.key), shown: shown.length, more };
}

/** The keys went out: they never push again. */
export function ackDigest(db: Db, keys: readonly string[], now: number = Date.now()): number {
  let added = 0;
  for (const key of keys) added += db.prepare("INSERT OR IGNORE INTO lane_pilot_owner_push(key,pushed_at) VALUES (?,?)").run(key, now).changes;
  return added;
}
