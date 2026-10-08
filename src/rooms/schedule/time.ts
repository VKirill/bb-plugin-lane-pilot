import { cronProblem, timezoneProblem } from "../../workflow/cron";

/**
 * The time of a scheduled task: the next moments a five-field cron fires in an IANA zone, with the clock changes of that zone
 * handled the way the classic cron does (and the way a person reads «every day at 02:30»):
 *
 * - A time that happens once a day (a fixed hour) fires **once** on the day the clocks go back, at its first occurrence.
 * - A time that falls into the hour the clocks skip forward fires **once**, shifted by the length of the gap (02:30 becomes 03:30).
 * - A schedule whose hour is a wildcard (`*`, or a step of it) follows real time: it fires in both passes of a repeated hour and never in a skipped one.
 *
 * Names (`mon`, `jan`) are not accepted, the same limits as `src/workflow/cron.ts`; day-of-month and day-of-week combine with OR when
 * both are restricted, with AND otherwise (as in Vixie cron). Sunday is 0 or 7.
 */
const MINUTE = 60_000;
const DAY = 86_400_000;
/** How far ahead one search goes: a yearly `29 2` schedule needs a leap year. */
const MAX_SCAN_DAYS = 366 * 9;

export type CronPlan = { minutes: number[]; hours: number[]; dom: Set<number>; months: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean; hourWild: boolean };

function expandField(field: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const found = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u.exec(part)!;
    const [, range = "", stepText] = found;
    const step = stepText ? Number(stepText) : 1;
    let low = min, high = max;
    if (range !== "*") {
      const [first, last] = range.split("-").map(Number) as [number, number?];
      low = first; high = last ?? (stepText ? max : first);
    }
    for (let value = low; value <= high; value += step) out.add(value);
  }
  return [...out].sort((a, b) => a - b);
}

export function cronPlan(cron: string): CronPlan {
  const problem = cronProblem(cron);
  if (problem) throw new Error(problem);
  const fields = cron.trim().split(/\s+/u);
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  return {
    minutes: expandField(minute, 0, 59), hours: expandField(hour, 0, 23), dom: new Set(expandField(dom, 1, 31)),
    months: new Set(expandField(month, 1, 12)), dow: new Set(expandField(dow, 0, 7).map((day) => day % 7)),
    domStar: dom.startsWith("*"), dowStar: dow.startsWith("*"), hourWild: hour.startsWith("*"),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let found = formatters.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timezone, found);
  }
  return found;
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
export function offsetAt(ms: number, timezone: string): number {
  const parts = formatter(timezone).formatToParts(new Date(ms));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour") % 24, pick("minute"), pick("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instants at which a wall clock reads this time in the zone: none (a skipped time), one, or two (a repeated time). */
function instantsOf(wall: number, timezone: string, offsets: { before: number; after: number }): { instants: number[]; shifted: number } {
  const { before, after } = offsets;
  // The common day has no clock change: both offsets are one and every wall time is one instant.
  if (before === after) return { instants: [wall - before], shifted: wall - before };
  const instants = [...new Set([before, after])].map((offset) => wall - offset).filter((instant) => offsetAt(instant, timezone) === wall - instant).sort((a, b) => a - b);
  return { instants, shifted: wall - before };
}

/** The fire times of a cron in a zone after `afterMs` (exclusive), oldest first, at most `limit`, none later than `untilMs`. */
export function fireTimes(cron: string, timezone: string, afterMs: number, options: { limit?: number; untilMs?: number } = {}): number[] {
  const plan = cronPlan(cron);
  const limit = options.limit ?? 1;
  const until = options.untilMs ?? Infinity;
  const startParts = formatter(timezone).formatToParts(new Date(afterMs));
  const pick = (type: string) => Number(startParts.find((part) => part.type === type)!.value);
  let day = Math.floor(Date.UTC(pick("year"), pick("month") - 1, pick("day")) / DAY) - 1;
  const found: number[] = [];
  let settled = 0;
  for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned += 1, day += 1) {
    const date = new Date(day * DAY);
    const month = date.getUTCMonth() + 1, dayOfMonth = date.getUTCDate(), weekday = date.getUTCDay();
    if (!plan.months.has(month)) continue;
    const domHit = plan.dom.has(dayOfMonth), dowHit = plan.dow.has(weekday);
    const dayHit = plan.domStar && plan.dowStar ? true : plan.domStar ? dowHit : plan.dowStar ? domHit : domHit || dowHit;
    if (!dayHit) continue;
    const offsets = { before: offsetAt(day * DAY - DAY, timezone), after: offsetAt(day * DAY + 2 * DAY, timezone) };
    for (const hour of plan.hours) for (const minute of plan.minutes) {
      const wall = day * DAY + hour * 60 * MINUTE + minute * MINUTE;
      const { instants, shifted } = instantsOf(wall, timezone, offsets);
      const chosen = instants.length === 0 ? (plan.hourWild ? [] : [shifted]) : plan.hourWild ? instants : [instants[0]!];
      for (const instant of chosen) if (instant > afterMs && instant <= until) found.push(instant);
    }
    // A day's instants can land after the next day's first only by a clock shift of under a day, so one more day settles the order.
    if (found.length >= limit) { settled += 1; if (settled > 1) break; }
    if (day * DAY > until + 2 * DAY) break;
  }
  return [...new Set(found)].sort((a, b) => a - b).slice(0, limit);
}

export const nextFire = (cron: string, timezone: string, afterMs: number): number | null => fireTimes(cron, timezone, afterMs, { limit: 1 })[0] ?? null;

/** What is wrong with a cron + zone pair, or null. */
export function scheduleTimeProblem(cron: string, timezone: string): string | null {
  return cronProblem(cron) ?? timezoneProblem(timezone);
}

/** «30m», «2h», «1d», «in 2 hours», «через 2 ч»: a delay in ms, or null when the text is not one. */
export function parseDelay(text: string): number | null {
  const found = /^\s*(?:in|через)?\s*(\d+(?:[.,]\d+)?)\s*(m|min|mins|minutes?|мин\w*|h|hr|hrs|hours?|ч|час\w*|d|days?|д|дн\w*|дней|сут\w*)\s*$/iu.exec(text);
  if (!found) return null;
  const amount = Number(found[1]!.replace(",", "."));
  const unit = found[2]!.toLowerCase();
  const scale = /^(m|min|мин)/u.test(unit) ? MINUTE : /^(h|ч)/u.test(unit) ? 60 * MINUTE : DAY;
  const ms = Math.round(amount * scale);
  return ms >= MINUTE ? ms : null;
}
