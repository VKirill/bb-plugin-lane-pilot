import type Database from "better-sqlite3";
import { addToIndexes, dropMemoryIndexes, estimateTokens, heldClause, OBSERVED_QUARANTINE_MS, scopeValuesFor, type MemoryAudience } from "@lane-pilot/memory-core";
import { episodeLines, minHits, queryWords, wordHits, type Episode } from "../logic";

/**
 * The cold tier, the episode layer and the misses (SMA D2-8), around the PM's memory query (`runMemoryContext`):
 * - a note expired for idleness (90 days given to nobody, no date of its own) is the cold tier: kept, out of every brief. When a PM query finds
 *   fewer than three active notes, the cold tier is searched with the same audience, bot, section, trust and conflict-hold rules as active memory.
 *   Matches are returned as candidates. They stay expired until a later write brings them back through the write door;
 * - the past tasks of the reader's sections whose title or objective share the query's words are added with how they ended;
 * - cold notes and episodes share the context budget with the active pack. A query that found nothing is a miss on record.
 */
type Db = Database.Database;
// Idle only. A budget eviction, a passed date, or a refuted note is not a candidate to bring back (F02-5). NULL is a row expired before the reason column.
const COLD = "status='expired' AND kind='note' AND valid_until IS NULL AND superseded_by IS NULL AND (expired_reason='idle' OR expired_reason IS NULL)";
const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

export type TierRead = {
  projectId: string;
  chain?: readonly string[];
  audience?: MemoryAudience;
  personalBot?: string;
  role?: string;
  includeObserved?: boolean;
  now?: number;
};

function scopeIn(column: string, chain: readonly string[]): string {
  return `${column} IN (${scopeValuesFor(chain).map(sqlString).join(",")})`;
}

export function coldMatches(db: Db, projectId: string, query: string, limit = 3, read: Omit<TierRead, "projectId"> = {}): Array<{ id: string; content: string; concepts: string[]; hits: number }> {
  const words = queryWords(query);
  if (!words.length) return [];
  const now = Math.floor(read.now ?? Date.now());
  const audience = read.audience ?? "subagent";
  const personalBot = read.personalBot ?? "";
  const trust = read.includeObserved ? "" : ` AND (trust='confirmed' OR created_at<=${now - OBSERVED_QUARANTINE_MS})`;
  const rows = db.prepare(`SELECT id, content, concepts_json FROM lane_pilot_memory WHERE project_id=? AND audience=? AND personal_bot=? AND ${COLD} AND ${scopeIn("scope_json", read.chain ?? [])}${trust}${heldClause(db, "lane_pilot_memory")}`).all(projectId, audience, personalBot) as Array<{ id: string; content: string; concepts_json: string }>;
  return rows.map((row) => ({ id: row.id, content: row.content, concepts: JSON.parse(row.concepts_json) as string[], hits: wordHits(`${row.content} ${row.concepts_json}`, words) }))
    .filter((row) => row.hits >= minHits(words)).sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id)).slice(0, limit);
}

/**
 * Brings cold notes back through the write door: active again, used now, in the search indexes. The read path does not
 * call this. A candidate stays expired until a write decides it still fits the budget.
 */
export function promote(db: Db, projectId: string, notes: ReadonlyArray<{ id: string; content: string; concepts: string[] }>, query: string, now = Date.now()): number {
  let promoted = 0;
  for (const note of notes) {
    const changed = db.prepare(`UPDATE lane_pilot_memory SET status='active', last_used_at=? WHERE project_id=? AND id=? AND ${COLD}`).run(now, projectId, note.id).changes;
    if (!changed) continue;
    addToIndexes(db as never, projectId, note.id, note.content, note.concepts);
    db.prepare("INSERT OR IGNORE INTO lane_pilot_memory_promotion(project_id,memory_id,query,at) VALUES (?,?,?,?)").run(projectId, note.id, query.slice(0, 500), now);
    promoted += 1;
  }
  return promoted;
}

/**
 * Back to cold (taxonomy audit #4): a note the write door re-activated but nobody was given for the same idle window goes
 * back to the cold tier — promotion was a hypothesis, not a prize. The promotion row stays as its history.
 */
export function demoteUnusedPromotions(db: Db, now = Date.now(), idleMs = 90 * 86_400_000): number {
  const rows = db.prepare(`SELECT m.id FROM lane_pilot_memory m JOIN lane_pilot_memory_promotion p ON p.memory_id=m.id AND p.project_id=m.project_id
    WHERE m.status='active' AND m.last_used_at=p.at AND p.at<?`).all(now - idleMs) as Array<{ id: string }>;
  for (const row of rows) {
    db.prepare("UPDATE lane_pilot_memory SET status='expired', expired_reason='idle' WHERE id=? AND status='active'").run(row.id);
    dropMemoryIndexes(db, "", row.id);
  }
  return rows.length;
}

export function episodes(db: Db, projectId: string, query: string, limit = 3, read: Omit<TierRead, "projectId"> = {}): Episode[] {
  return episodeCandidates(db, projectId, query, limit, read);
}

/** The lexical shortlist Jev can re-rank (B6): same query and rows as `episodes`, a deeper cut for the judge. */
export function episodeCandidates(db: Db, projectId: string, query: string, limit = 3, read: Omit<TierRead, "projectId"> = {}): Episode[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const rows = db.prepare(`SELECT t.id AS task_id, t.contract_json, t.created_at,
      (SELECT a.state FROM lane_pilot_attempt a WHERE a.run_id=t.run_id AND a.task_id=t.id ORDER BY a.attempt_no DESC, a.updated_at DESC LIMIT 1) AS state,
      (SELECT a.reason FROM lane_pilot_attempt a WHERE a.run_id=t.run_id AND a.task_id=t.id ORDER BY a.attempt_no DESC, a.updated_at DESC LIMIT 1) AS reason
    FROM lane_pilot_task t JOIN lane_pilot_run r ON r.id=t.run_id
    WHERE r.project_id=? AND (r.settings_scopes_json IS NULL OR r.settings_scopes_json='' OR ${scopeIn("r.settings_scopes_json", read.chain ?? [])})
    ORDER BY t.created_at DESC LIMIT 400`).all(projectId) as Array<{ task_id: string; contract_json: string; created_at: number; state: string | null; reason: string | null }>;
  return rows.flatMap((row) => {
    let contract: { title?: unknown; display_title?: unknown; objective?: unknown } = {};
    try { contract = JSON.parse(row.contract_json) as typeof contract; } catch { return []; }
    const title = String(contract.display_title || contract.title || row.task_id);
    const hits = wordHits(`${title} ${String(contract.objective ?? "")}`, words);
    return hits >= minHits(words) && row.state ? [{ episode: { taskId: row.task_id, title, state: row.state, reason: row.reason, at: row.created_at }, hits }] : [];
  }).sort((a, b) => b.hits - a.hits || b.episode.at - a.episode.at).slice(0, limit).map((row) => row.episode);
}

function fitLines(header: string, lines: readonly string[], room: number): { text: string; used: number; kept: number } {
  if (!lines.length || room <= 0) return { text: "", used: 0, kept: 0 };
  let used = estimateTokens(header);
  if (used > room) return { text: "", used: 0, kept: 0 };
  const kept: string[] = [];
  for (const line of lines) {
    const cost = estimateTokens(line);
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }
  if (!kept.length) return { text: "", used: 0, kept: 0 };
  return { text: [header, ...kept].join("\n"), used, kept: kept.length };
}

/** What the PM gets on top of the active notes: cold candidates and past tasks, inside the same token budget. A miss is recorded when nothing at all was found. Status is not changed. */
export function enrichMemoryContext(db: Db, input: { projectId: string; query: string; activeCount: number; now?: number; chain?: readonly string[]; audience?: MemoryAudience; personalBot?: string; role?: string; includeObserved?: boolean; budget?: number; activeTokens?: number; episodesList?: Episode[] }): { text: string; promoted: string[]; episodes: number; miss: boolean; addedTokens: number } {
  const now = input.now ?? Date.now();
  const read: Omit<TierRead, "projectId"> = { chain: input.chain, audience: input.audience, personalBot: input.personalBot, role: input.role, includeObserved: input.includeObserved, now };
  const cold = input.activeCount < 3 ? coldMatches(db, input.projectId, input.query, 3, read) : [];
  const past = input.episodesList ?? episodes(db, input.projectId, input.query, 3, read);
  const room = input.budget == null ? Number.POSITIVE_INFINITY : Math.max(0, input.budget - (input.activeTokens ?? 0));
  const coldLines = cold.map((note) => `- ${note.content.replace(/\s+/g, " ").trim()}`);
  const coldFit = fitLines("Notes from the cold tier (still expired; a write decides whether they come back):", coldLines, room);
  const episodeText = episodeLines(past);
  const episodeCost = estimateTokens(episodeText);
  const episodesFit = episodeText && coldFit.used + episodeCost <= room ? episodeText : "";
  const episodeTokens = episodesFit ? episodeCost : 0;
  const delivered = cold.slice(0, coldFit.kept);
  const miss = input.activeCount === 0 && !cold.length && !past.length;
  if (miss) db.prepare("INSERT INTO lane_pilot_memory_miss(project_id,query,at) VALUES (?,?,?)").run(input.projectId, input.query.slice(0, 1000), now);
  const text = [coldFit.text, episodesFit].filter(Boolean).join("\n\n");
  return { text, promoted: delivered.map((note) => note.id), episodes: episodesFit ? past.length : 0, miss, addedTokens: estimateTokens(text) };
}

/** The tiers at a glance: the cold tier's size, how many of it were needed again, and the latest misses. */
export function tierReport(db: Db, projectId?: string, now = Date.now()) {
  const where = projectId ? "AND project_id=?" : "", args = projectId ? [projectId] : [];
  const cold = (db.prepare(`SELECT count(*) AS n FROM lane_pilot_memory WHERE ${COLD} ${where}`).get(...args) as { n: number }).n;
  const promoted = (db.prepare(`SELECT count(DISTINCT project_id||memory_id) AS n FROM lane_pilot_memory_promotion WHERE 1=1 ${where}`).get(...args) as { n: number }).n;
  const misses = db.prepare(`SELECT project_id AS projectId, query, at FROM lane_pilot_memory_miss WHERE at>=? ${where} ORDER BY at DESC LIMIT 50`).all(now - 30 * 86_400_000, ...args);
  return { cold, promoted, neededAgainShare: cold + promoted ? Math.round((promoted / (cold + promoted)) * 1000) / 1000 : null, misses };
}
