import type { MemoryDatabase } from "./store";

/** A session or an import is one voice: its notes wait this long for a second source before a writer reads them. */
export const OBSERVED_QUARANTINE_MS = 24 * 3_600_000;
/** A note nobody was given for this long stops being mixed; a note is not eternal just because nobody deleted it. Core, rules and file imports (their file decides) are exempt. */
export const NOTE_IDLE_MS = 90 * 24 * 3_600_000;

/** Hides a record (it stays in the table, leaves every index) with the status that says why. */
export function hideRecord(db: MemoryDatabase, projectId: string, id: string, status: "superseded" | "expired", supersededBy: string | null, unindex: (projectId: string, id: string) => void): boolean {
  const changed = db.prepare("UPDATE lane_pilot_memory SET status=?, superseded_by=COALESCE(?,superseded_by) WHERE project_id=? AND id=? AND status='active'").run(status, supersededBy, projectId, id).changes === 1;
  if (changed) unindex(projectId, id);
  return changed;
}

/** Marks every active record of the scope whose date passed, and every note nobody was given for 90 days, expired. */
export function expireMemory(db: MemoryDatabase, projectId: string, personalBot: string, now: number, unindex: (projectId: string, id: string) => void): string[] {
  const due = db.prepare(`SELECT id FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? AND status='active'
    AND ((valid_until IS NOT NULL AND valid_until<=?) OR (${idleSql("lane_pilot_memory", now)}))`).all(projectId, personalBot, now) as Array<{ id: string }>;
  return due.map((row) => row.id).filter((id) => hideRecord(db, projectId, id, "expired", null, unindex));
}

/** SQL for "a note nobody was given in 90 days" (rules are core, so they never match; imports follow their file). */
export function idleSql(alias: string, now: number): string {
  return `${alias}.kind='note' AND ${alias}.origin<>'import' AND ${alias}.concepts_json NOT LIKE '%"rule"%' AND COALESCE(${alias}.last_used_at,${alias}.created_at)<${Math.floor(now - NOTE_IDLE_MS)}`;
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

function trigrams(text: string): Set<string> {
  const flat = text.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  for (let index = 0; index + 3 <= flat.length; index++) out.add(flat.slice(index, index + 3));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Two notes are about the same subject when they share most of their tags (at least two) and read alike. Conservative
 * on purpose: two different facts about one area share tags but not wording, and must both stay.
 */
export function sameSubject(a: { content: string; concepts: string[] }, b: { content: string; concepts: string[] }): boolean {
  const ca = new Set(a.concepts), cb = new Set(b.concepts);
  let shared = 0;
  for (const item of ca) if (cb.has(item)) shared++;
  if (shared < 2 || shared / (ca.size + cb.size - shared) < 0.5) return false;
  return Math.max(jaccard(words(a.content), words(b.content)), dice(trigrams(a.content), trigrams(b.content))) >= 0.3;
}
