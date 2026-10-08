import { levelAt, stepsOf, LEVELS } from "./skills";
import { visibleRecords, type WhoamiOptions, type WhoamiRecord, type WhoamiResult } from "./whoami";

/**
 * The year review (A7): what the owner did in a calendar year, how their skills grew and what was made. Composed from the records
 * each time, like «who am I», with the same privacy rules (`visibleRecords`: sensitive records only when asked for, `publicOnly`
 * keeps what the owner marked public, candidates and rejected records never). Pure; the host runs it next to the data.
 */
const month = (at: number | null): string => (at ? new Date(at).toISOString().slice(0, 7) : "?");
const day = (at: number | null): string => (at ? new Date(at).toISOString().slice(0, 10) : "?");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function renderYearReview(records: readonly WhoamiRecord[], options: WhoamiOptions & { year?: number } = {}): WhoamiResult {
  const year = options.year ?? new Date(options.now ?? Date.now()).getUTCFullYear();
  const from = Date.UTC(year, 0, 1), to = Date.UTC(year + 1, 0, 1);
  const inYear = (at: number | null): boolean => at !== null && at >= from && at < to;
  const { shown, hiddenSensitive } = visibleRecords(records, options);
  const drafts = shown.filter((record) => record.status === "draft").length;
  const out: string[] = [`Year in review ${year} (from records with evidence; ${shown.length - drafts} confirmed${drafts ? `, ${drafts} still drafts` : ""}).`];

  /* ---- skills ---- */
  const grown: Array<{ record: WhoamiRecord; gain: number; line: string }> = [];
  for (const record of shown.filter((item) => item.kind === "skill")) {
    const steps = stepsOf(record.attributes);
    const before = levelAt(steps, `${year - 1}-12`), after = levelAt(steps, `${year}-12`);
    const rank = (level: string | null): number => (level ? LEVELS.indexOf(level as (typeof LEVELS)[number]) : -1);
    if (after && rank(after) > rank(before)) {
      grown.push({ record, gain: rank(after) - rank(before), line: `- ${record.title}: ${before ? `${before} → ${after}` : `new, reached ${after}`}` });
    } else if (!steps.length && inYear(record.firstSeen)) {
      grown.push({ record, gain: 0, line: `- ${record.title}: new (first seen ${month(record.firstSeen)})` });
    }
  }
  if (grown.length) {
    grown.sort((a, b) => b.gain - a.gain || num(b.record.attributes.commits) - num(a.record.attributes.commits));
    out.push("", `## Skills (${grown.length} grew or appeared)`, ...grown.slice(0, 25).map((item) => item.line));
  }

  /* ---- what was made ---- */
  const projects = shown.filter((record) => record.kind === "project" && (inYear(record.firstSeen) || inYear(record.lastSeen)));
  if (projects.length) {
    projects.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    out.push("", `## Projects (${projects.length})`);
    for (const record of projects.slice(0, 25)) {
      const started = inYear(record.firstSeen) ? "started" : "worked on";
      out.push(`- ${record.title} (${started}, ${month(record.firstSeen)}…${month(record.lastSeen)})${record.statement && record.statement !== record.title ? ` — ${record.statement}` : ""}`);
    }
  }

  /* ---- activity: commits per month across projects ---- */
  const perMonth: Record<string, number> = {};
  for (const record of shown.filter((item) => item.kind === "project" && item.attributes.origin === "git")) {
    const byMonth = record.attributes.byMonth;
    if (byMonth && typeof byMonth === "object") for (const [key, value] of Object.entries(byMonth as Record<string, unknown>)) if (key.startsWith(`${year}-`)) perMonth[key] = (perMonth[key] ?? 0) + num(value);
  }
  const months = Object.entries(perMonth).sort(([a], [b]) => a.localeCompare(b));
  if (months.length) {
    const total = months.reduce((sum, [, count]) => sum + count, 0);
    const busiest = [...months].sort((a, b) => b[1] - a[1])[0]!;
    out.push("", `## Activity`, `- ${total} commits in ${months.length} active months; busiest ${busiest[0]} (${busiest[1]}).`);
  }

  /* ---- events ---- */
  const events = shown.filter((record) => record.kind === "event" && inYear(record.firstSeen)).sort((a, b) => (a.firstSeen ?? 0) - (b.firstSeen ?? 0));
  if (events.length) {
    out.push("", `## Milestones (${events.length})`);
    for (const record of events.slice(0, 40)) out.push(`- ${day(record.firstSeen)} ${record.title}`);
    if (events.length > 40) out.push(`- … ${events.length - 40} more`);
  }

  if (out.length === 1) out.push("Nothing recorded for this year yet.");
  if (hiddenSensitive && !options.publicOnly) out.push("", `${hiddenSensitive} sensitive records are not shown; they are given only when you ask for them by name.`);
  return { text: out.join("\n"), included: shown.length, hiddenSensitive, drafts };
}
