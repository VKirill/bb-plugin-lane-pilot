import type { MemoryDatabase } from "./store";
import type { MemoryRecord } from "./settings";

/** A session or an import is one voice: its notes wait this long for a second source before a writer reads them. */
export const OBSERVED_QUARANTINE_MS = 24 * 3_600_000;
/** A note nobody was given for this long stops being mixed; a note is not eternal just because nobody deleted it. Core, rules and file imports (their file decides) are exempt. */
export const NOTE_IDLE_MS = 90 * 24 * 3_600_000;

export type ExpiredReason = "budget" | "idle" | "dated" | "refuted";

/** A failed check refutes a note only when the failure quotes a long stretch of that note. A generic red check does not. */
export function noteRefutedByCheck(content: string, failureText: string): boolean {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length < 40 || failureText.length < 40) return false;
  for (let start = 0; start + 40 <= flat.length; start += 8) if (failureText.includes(flat.slice(start, start + 40))) return true;
  return false;
}

/** Hides a record (it stays in the table, leaves every index) with the status that says why. An expiry records budget eviction, idleness, a passed date, or a check that quoted the note; a replacement clears that reason. */
/** The memory-profile nightly curator is off. A note that still says it is running is dated, not a fact. */
const STALE_CURATOR = /memory-profile[\s\S]{0,80}nightly|nightly[\s\S]{0,80}memory-profile/i;

export function retireStaleCuratorClaims(db: MemoryDatabase, projectId: string, unindex: (projectId: string, id: string) => void): string[] {
  const rows = db.prepare("SELECT id, content FROM lane_pilot_memory WHERE project_id=? AND status='active'").all(projectId) as Array<{ id: string; content: string }>;
  const gone: string[] = [];
  for (const row of rows) if (STALE_CURATOR.test(row.content) && hideRecord(db, projectId, row.id, "expired", null, unindex, "dated")) gone.push(row.id);
  return gone;
}

export function hideRecord(db: MemoryDatabase, projectId: string, id: string, status: "superseded" | "expired", supersededBy: string | null, unindex: (projectId: string, id: string) => void, expiredReason?: ExpiredReason | null): boolean {
  const changed = db.prepare("UPDATE lane_pilot_memory SET status=?, superseded_by=COALESCE(?,superseded_by), expired_reason=CASE WHEN ?='expired' THEN ? ELSE NULL END WHERE project_id=? AND id=? AND status='active'").run(status, supersededBy, status, status === "expired" ? expiredReason ?? null : null, projectId, id).changes === 1;
  if (changed) unindex(projectId, id);
  return changed;
}

/** Marks every active record of the scope whose date passed, and every note nobody was given for 90 days, expired. The reason is stored apart from the status. */
export function expireMemory(db: MemoryDatabase, projectId: string, personalBot: string, now: number, unindex: (projectId: string, id: string) => void): string[] {
  const due = db.prepare(`SELECT id, CASE WHEN valid_until IS NOT NULL AND valid_until<=? THEN 'dated' ELSE 'idle' END AS reason FROM lane_pilot_memory WHERE project_id=? AND personal_bot=? AND status='active'
    AND ((valid_until IS NOT NULL AND valid_until<=?) OR (${idleSql("lane_pilot_memory", now)}))`).all(now, projectId, personalBot, now) as Array<{ id: string; reason: ExpiredReason }>;
  return due.filter((row) => hideRecord(db, projectId, row.id, "expired", null, unindex, row.reason)).map((row) => row.id);
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

/**
 * How well a record served the briefs it went into: accepted attempts over attempts, smoothed so one lucky or unlucky
 * use does not decide. A record never used is neutral (0.5).
 */
export function memoryUsefulness(record: Pick<MemoryRecord, "useCount" | "acceptedCount">): number {
  const raw = ((record.acceptedCount ?? 0) + 1) / ((record.useCount ?? 0) + 2);
  // Accepted counted without a use scored 4.5. One rejection stays below an unused note, so the floor is not raised.
  return Math.min(1.5, raw);
}

/** Records mixed into a brief: counts the use and when it happened. */
export function recordMemoryMixed(db: MemoryDatabase, projectId: string, ids: readonly string[], now = Date.now()): void {
  const update = db.prepare("UPDATE lane_pilot_memory SET use_count=use_count+1, last_used_at=? WHERE project_id=? AND id=?");
  for (const id of new Set(ids)) update.run(now, projectId, id);
}

/** Ids and token count of one retrieval. No note text. */
export function recordMemoryReceipt(db: MemoryDatabase, input: { projectId: string; role: string; returnedIds: readonly string[]; packedIds: readonly string[]; tokens: number; now?: number }): void {
  const now = input.now ?? Date.now();
  const id = `mr_${now}_${input.role}_${input.packedIds.join(",")}`;
  db.prepare("INSERT INTO lane_pilot_memory_receipt(id,project_id,role,returned_ids,packed_ids,tokens,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, input.projectId, input.role, JSON.stringify(input.returnedIds), JSON.stringify(input.packedIds), input.tokens, now);
}

/** A critic or reviewer mix. Separate from use_count so it cannot move usefulness. */
export function recordCriticUse(db: MemoryDatabase, projectId: string, ids: readonly string[]): void {
  const update = db.prepare("UPDATE lane_pilot_memory SET critic_count=critic_count+1 WHERE project_id=? AND id=?");
  for (const id of new Set(ids)) update.run(projectId, id);
}

/** The attempt a record was mixed into was accepted. */
export function recordMemoryAccepted(db: MemoryDatabase, projectId: string, ids: readonly string[]): void {
  const update = db.prepare("UPDATE lane_pilot_memory SET accepted_count=accepted_count+1 WHERE project_id=? AND id=?");
  for (const id of new Set(ids)) update.run(projectId, id);
}
