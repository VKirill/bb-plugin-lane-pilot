import { callReason, type OwnerItem } from "./owner-item";

/**
 * Pure push configuration, quiet-hours math, and Telegram/bell digest formatting rules.
 * Runtime-neutral: no node:, no SQLite, no BB SDK.
 */
/** `bell` is the browser bell (SMA m_ws_notify): on unless the owner stored `off`. It skips what the Telegram digest already announced. */
export type PushConfig = { enabled: boolean; quiet: string; timezone: string; bell?: boolean; dryRun?: boolean };
export const DEFAULT_PUSH_CONFIG: PushConfig = { enabled: true, quiet: "23:00-08:00", timezone: "Europe/Madrid" };
export const PUSH_CONFIG_KEYS = ["enabled", "quiet", "timezone", "bell", "dry_run"] as const;
/** At most this many items are named in one message; the rest are counted. */
export const DIGEST_LINES = 6;
/** An open item is said again once, this long after its first push. */
export const REPEAT_AFTER_MS = 6 * 3_600_000;

export type Digest = { send: boolean; reason: "disabled" | "quiet_hours" | "nothing_new" | null; text: string; keys: string[]; shown: number; more: number };

/** The `bell:` keys in lane_pilot_owner_push mark a wake item the browser bell already announced (SMA m_ws_notify). */
export const BELL_PREFIX = "bell:";
export const OWNER_BELL_DAILY_CAP = 5;
export const DIGEST_WINDOW_HOUR = 9;
/** The mark that the bell has been seeded on this install (lane_pilot_owner_config). */
export const BELL_SEEDED = "bell_seeded";

export type BellNotice = {
  send: boolean;
  reason: "disabled" | "quiet_hours" | "daily_cap" | "nothing_new" | null;
  title: string;
  text: string;
  keys: string[];
  waitUntil?: number;
};
export type PlanBellOptions = { bypassDailyCap?: boolean; includeLater?: boolean };

export const QUIET_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export function validTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function resolvePushConfig(stored: Record<string, string>, own: Partial<PushConfig>): PushConfig {
  const old: PushConfig = {
    enabled: stored.enabled === undefined ? DEFAULT_PUSH_CONFIG.enabled : stored.enabled === "on",
    quiet: stored.quiet && QUIET_RE.test(stored.quiet) ? stored.quiet : DEFAULT_PUSH_CONFIG.quiet,
    timezone: stored.timezone && validTimezone(stored.timezone) ? stored.timezone : DEFAULT_PUSH_CONFIG.timezone,
  };
  // A global row (`owner_push.*`, written by the screen and by this command) wins over the old table, which stays as the fallback.
  // The bell has no global row: it lives in this room's own table; unset is on, only a stored «off» silences it.
  return {
    enabled: own.enabled ?? old.enabled,
    quiet: own.quiet ?? old.quiet,
    timezone: own.timezone ?? old.timezone,
    bell: stored.bell !== "off",
    ...(stored.dry_run === "on" ? { dryRun: true } : {}),
  };
}

export function validatePushPatch(patch: Record<string, string | undefined>): {
  ownKeys: Array<{ key: "bell" | "dry_run"; value: string }>;
  hubFields: Record<string, unknown>;
} {
  const ownKeys: Array<{ key: "bell" | "dry_run"; value: string }> = [];
  const hubFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if ((key === "enabled" || key === "bell" || key === "dry_run") && value !== "on" && value !== "off") {
      throw new Error(`${key} is on or off`);
    }
    if (key === "quiet" && !QUIET_RE.test(value)) {
      throw new Error("quiet is HH:MM-HH:MM in the time zone (23:00-08:00; 00:00-00:00 means no quiet hours)");
    }
    if (key === "timezone" && !validTimezone(value)) {
      throw new Error(`unknown time zone «${value}» (an IANA name such as Europe/Madrid)`);
    }
    if (!(PUSH_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(`unknown setting «${key}» (${PUSH_CONFIG_KEYS.join(", ")})`);
    }
    if (key === "bell" || key === "dry_run") {
      ownKeys.push({ key, value });
      continue;
    }
    hubFields[key] = key === "enabled" ? value === "on" : value;
  }
  return { ownKeys, hubFields };
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

export function localParts(now: number, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute") };
}

/** Minutes since local midnight in `timezone`. */
function localMinutes(now: number, timezone: string): number {
  const p = localParts(now, timezone);
  return p.hour * 60 + p.minute;
}

export function localDateTimeUtcMs(parts: LocalParts, timezone: string): number {
  const targetAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  let guess = targetAsUtc;
  for (let i = 0; i < 3; i++) {
    const actual = localParts(guess, timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const diff = targetAsUtc - actualAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function localStartOfDayMs(now: number, timezone: string): number {
  const p = localParts(now, timezone);
  return localDateTimeUtcMs({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, timezone);
}

/** Whether `now` falls in the quiet window; a window that wraps midnight (23:00-08:00) is one window; equal ends mean none. */
export function inQuietHours(now: number, quiet: string, timezone: string): boolean {
  const match = QUIET_RE.exec(quiet);
  if (!match) return false;
  const from = Number(match[1]) * 60 + Number(match[2]), to = Number(match[3]) * 60 + Number(match[4]);
  if (from === to) return false;
  const at = localMinutes(now, timezone);
  return from < to ? at >= from && at < to : at >= from || at < to;
}

/** Returns the UTC ms timestamp when the active quiet-hours window ends, or null when outside quiet hours. */
export function quietHoursEnd(now: number, quiet: string, timezone: string): number | null {
  const match = QUIET_RE.exec(quiet);
  if (!match) return null;
  const from = Number(match[1]) * 60 + Number(match[2]), to = Number(match[3]) * 60 + Number(match[4]);
  if (from === to) return null;
  const p = localParts(now, timezone);
  const at = p.hour * 60 + p.minute;
  const inside = from < to ? at >= from && at < to : at >= from || at < to;
  if (!inside) return null;
  const dayOffset = from > to && at >= from ? 1 : 0;
  return localDateTimeUtcMs({ year: p.year, month: p.month, day: p.day + dayOffset, hour: Math.floor(to / 60), minute: to % 60 }, timezone);
}

/** Computes the next daily digest timestamp outside quiet hours for batching overflow owner bells. */
export function nextDigestWindow(now: number, quiet: string, timezone: string, digestHour: number = DIGEST_WINDOW_HOUR): number {
  const p = localParts(now, timezone);
  const at = p.hour * 60 + p.minute;
  const dayOffset = at < digestHour * 60 ? 0 : 1;
  let candidate = localDateTimeUtcMs({ year: p.year, month: p.month, day: p.day + dayOffset, hour: digestHour, minute: 0 }, timezone);
  const quietEnd = quietHoursEnd(candidate, quiet, timezone);
  if (quietEnd !== null && quietEnd > candidate) candidate = quietEnd;
  return candidate;
}

const LABEL: Record<string, string> = {
  deferral_overdue: "просрочена отсрочка",
  memory_conflict: "конфликт памяти",
  night: "ночь",
  wall: "стена",
  backlog: "бэклог",
  rule_proposal: "правило",
  learning: "обучение",
  deferral_term: "нужен срок",
};
const REASON_LABEL: Record<string, string> = { decision: "решение", blocked: "стоит", red: "красное", term: "срок" };
const formatDigestLine = (item: OwnerItem) =>
  `• ${LABEL[item.source] ?? item.source} [${REASON_LABEL[callReason(item.kind)]}]: ${item.what.replace(/\s+/g, " ").slice(0, 110)}`;

export function formatDigestText(fresh: OwnerItem[]): { text: string; shown: number; more: number } {
  const shown = fresh.slice(0, DIGEST_LINES);
  const more = fresh.length - shown.length;
  const text = [
    `Lane Pilot: ждут владельца, новых — ${fresh.length}.`,
    ...shown.map(formatDigestLine),
    ...(more ? [`…и ещё ${more}.`] : []),
    "Что, почему и точное действие — на экране «Ждут владельца» (Lane Pilot → Система) или `bb lane-pilot waiting`. Ждать ответа ничего не будет.",
  ].join("\n");
  return { text, shown: shown.length, more };
}
