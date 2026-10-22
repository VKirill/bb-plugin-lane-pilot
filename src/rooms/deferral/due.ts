/**
 * The dates an owner's message names (SMA rule 5: the term comes from the human's own words). A small explicit parser, no guessing:
 * a form that is not listed here names no date. Calendar days are UTC; a term runs to the end of its day.
 *
 * Forms: 2026-11-05 · 5.11.2026, 5.11 · «5 ноября» (with a year or without) · «Nov 5», «5 November» · «через 14 дней / 2 недели / месяц»,
 * «in 14 days» · «завтра», «послезавтра», «tomorrow» · «до пятницы», «в пятницу», «by Friday» (the next such day after the message).
 * A day and month without a year is the next one on or after the message's day.
 */
export type DueSource = "explicit" | "relative" | "weekday" | "default_14d" | "agent";
export type NamedDate = { day: string; dueAt: number; source: Exclude<DueSource, "default_14d" | "agent">; match: string };

const DAY = 86_400_000;
export const DEFAULT_TERM_DAYS = 14;
/** The furthest an agent may set a term (`defer <id> --due … --reason …`): a longer one is a new entry with its own reason. */
export const MAX_AGENT_TERM_DAYS = 30;

const pad = (n: number): string => String(n).padStart(2, "0");
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** The last millisecond of the UTC day `YYYY-MM-DD`. */
export const endOfDay = (day: string): number => Date.parse(`${day}T23:59:59.999Z`);
const startOf = (ms: number): number => Date.parse(`${dayOf(ms)}T00:00:00.000Z`);
/** The default term counted from `at`: the end of the day 14 days later. */
export const defaultTermFrom = (at: number): number => endOfDay(dayOf(startOf(at) + DEFAULT_TERM_DAYS * DAY));
const valid = (y: number, m: number, d: number): boolean => {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
};

const RU_MONTHS: Record<string, number> = { января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12 };
const EN_MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** Prefix of a weekday name -> JS day number (Sunday 0). */
const WEEKDAYS: Array<[string, number]> = [["понедельник", 1], ["вторник", 2], ["сред", 3], ["четверг", 4], ["пятниц", 5], ["суббот", 6], ["воскресень", 0],
  ["monday", 1], ["tuesday", 2], ["wednesday", 3], ["thursday", 4], ["friday", 5], ["saturday", 6], ["sunday", 0]];
const NUMBER_WORDS: Record<string, number> = { один: 1, одну: 1, два: 2, две: 2, пару: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, десять: 10, a: 1, an: 1, one: 1, two: 2, three: 3 };

const MONTH_RU = Object.keys(RU_MONTHS).join("|");
const MONTH_EN = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** The year of a day and month named without one: this year, or the next when it already passed before the message's day. */
function yearFor(m: number, d: number, at: number): number {
  const base = new Date(at).getUTCFullYear();
  return valid(base, m, d) && endOfDay(`${base}-${pad(m)}-${pad(d)}`) < startOf(at) ? base + 1 : base;
}

export function namedDates(text: string, at: number): NamedDate[] {
  const found = new Map<string, NamedDate>();
  const put = (source: NamedDate["source"], match: string, day: string): void => {
    if (!found.has(day)) found.set(day, { day, dueAt: endOfDay(day), source, match: match.trim() });
  };
  const add = (match: string, y: number, m: number, d: number): void => {
    if (valid(y, m, d)) put("explicit", match, `${y}-${pad(m)}-${pad(d)}`);
  };
  const addOffset = (source: NamedDate["source"], match: string, days: number): void => put(source, match, dayOf(startOf(at) + days * DAY));
  const addMonths = (match: string, months: number): void => {
    const base = new Date(startOf(at));
    base.setUTCMonth(base.getUTCMonth() + months);
    put("relative", match, dayOf(base.getTime()));
  };
  const lower = text.toLowerCase();
  for (const hit of lower.matchAll(/(?<![\d.-])(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) add(hit[0], Number(hit[1]), Number(hit[2]), Number(hit[3]));
  for (const hit of lower.matchAll(/(?<![\d.])(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}))?(?!\.?\d)/g)) {
    const m = Number(hit[2]), d = Number(hit[1]);
    add(hit[0], hit[3] ? (hit[3].length === 2 ? 2000 + Number(hit[3]) : Number(hit[3])) : yearFor(m, d, at), m, d);
  }
  for (const hit of lower.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MONTH_RU})(?![а-я])(?:\\s+(\\d{4}))?`, "g"))) {
    const m = RU_MONTHS[hit[2]!]!, d = Number(hit[1]);
    add(hit[0], hit[3] ? Number(hit[3]) : yearFor(m, d, at), m, d);
  }
  for (const hit of lower.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_EN})\\b(?:,?\\s+(\\d{4}))?`, "g"))) {
    const m = EN_MONTHS[hit[2]!.slice(0, 3)]!, d = Number(hit[1]);
    add(hit[0], hit[3] ? Number(hit[3]) : yearFor(m, d, at), m, d);
  }
  for (const hit of lower.matchAll(new RegExp(`\\b(${MONTH_EN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4}))?`, "g"))) {
    const m = EN_MONTHS[hit[1]!.slice(0, 3)]!, d = Number(hit[2]);
    add(hit[0], hit[3] ? Number(hit[3]) : yearFor(m, d, at), m, d);
  }
  // Relative to the message's own time.
  const addUnit = (match: string, n: number, unit: string): void => {
    if (n < 1 || n > 400) return;
    if (/^(дн|день|day)/.test(unit)) addOffset("relative", match, n);
    else if (/^(недел|week)/.test(unit)) addOffset("relative", match, 7 * n);
    else if (/^(месяц|month)/.test(unit)) addMonths(match, n);
  };
  for (const hit of lower.matchAll(/через\s+(\d+|[а-я]+)\s+(дн[а-я]*|недел[а-я]*|месяц[а-я]*)/g)) {
    const n = /^\d+$/.test(hit[1]!) ? Number(hit[1]) : NUMBER_WORDS[hit[1]!];
    if (n !== undefined) addUnit(hit[0], n, hit[2]!);
  }
  for (const hit of lower.matchAll(/через\s+(день|неделю|месяц)(?![а-я])/g)) addUnit(hit[0], 1, hit[1]!);
  for (const hit of lower.matchAll(/\bin\s+(\d+|an?|one|two|three)\s+(days?|weeks?|months?)\b/g)) {
    const n = /^\d+$/.test(hit[1]!) ? Number(hit[1]) : NUMBER_WORDS[hit[1]!];
    if (n !== undefined) addUnit(hit[0], n, hit[2]!);
  }
  for (const hit of lower.matchAll(/(?<![а-я])(завтра|послезавтра)(?![а-я])|\btomorrow\b/g)) addOffset("relative", hit[0], hit[1] === "послезавтра" ? 2 : 1);
  // The next such weekday after the message's day.
  const today = new Date(startOf(at)).getUTCDay();
  for (const hit of lower.matchAll(/(?<![а-я])(?:до|к|в|во|на)\s+([а-я]+)|\b(?:by|on|until|before|next)\s+([a-z]+)/g)) {
    const word = hit[1] ?? hit[2]!;
    const weekday = WEEKDAYS.find(([prefix]) => word.startsWith(prefix));
    if (weekday) addOffset("weekday", hit[0], ((weekday[1] - today + 6) % 7) + 1);
  }
  return [...found.values()].sort((a, b) => a.dueAt - b.dueAt);
}

/** `--due` as a day: `2026-11-05` or a full ISO time; null for anything else. */
export function dayOfArg(arg: string): string | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(arg.trim());
  if (!hit || !valid(Number(hit[1]), Number(hit[2]), Number(hit[3]))) return null;
  return `${hit[1]}-${hit[2]}-${hit[3]}`;
}

export type ResolvedTerm = { dueAt: number; day: string; source: DueSource; match: string | null };

/**
 * The term of a deferral from the owner's message. `claimed` is the day the caller wants (`--due`): the text must name it, else
 * the term is refused. Without `claimed` a single named date is taken, several are ambiguous, and none means the owner decided
 * without a date: the term is the message's day plus 14 days (`default_14d`).
 */
export function resolveTerm(text: string, at: number, claimed?: string): { ok: true; term: ResolvedTerm } | { ok: false; error: string } {
  const named = namedDates(text, at);
  const list = named.map((item) => `${item.day} («${item.match}»)`).join(", ");
  if (claimed !== undefined) {
    const day = dayOfArg(claimed);
    if (!day) return { ok: false, error: `--due «${claimed}» is not a date; write it as 2026-11-05` };
    const hit = named.find((item) => item.day === day);
    if (hit) return { ok: true, term: { dueAt: hit.dueAt, day, source: hit.source, match: hit.match } };
    return { ok: false, error: `the owner's message does not name ${day}${named.length ? `; it names ${list}` : " (it names no date; leave --due out to take the default of 14 days from the message)"}` };
  }
  if (named.length > 1) return { ok: false, error: `the owner's message names several dates (${list}); pass --due with the one this deferral gets` };
  if (named.length === 1) return { ok: true, term: { dueAt: named[0]!.dueAt, day: named[0]!.day, source: named[0]!.source, match: named[0]!.match } };
  const day = dayOf(startOf(at) + DEFAULT_TERM_DAYS * DAY);
  return { ok: true, term: { dueAt: endOfDay(day), day, source: "default_14d", match: null } };
}
