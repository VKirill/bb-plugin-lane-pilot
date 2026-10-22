import type Database from "better-sqlite3";
import { addToIndexes } from "@lane-pilot/memory-core";
import { episodeLines, minHits, queryWords, wordHits, type Episode } from "../logic";

/**
 * The cold tier, the episode layer and the misses (SMA D2-8), around the PM's memory query (`runMemoryContext`):
 * - a note expired for idleness (90 days given to nobody, no date of its own) is the cold tier: kept, out of every brief. When a PM query finds
 *   fewer than three active notes, the cold tier is searched by the query's words and the best matches come back to the active corpus;
 * - the past tasks of the project whose title or objective share the query's words are added with how they ended;
 * - a query that found nothing, active or cold, is a miss on record: a candidate question for memory-eval's golden set.
 */
type Db = Database.Database;
const COLD = "status='expired' AND kind='note' AND valid_until IS NULL AND superseded_by IS NULL";

export function coldMatches(db: Db, projectId: string, query: string, limit = 3): Array<{ id: string; content: string; concepts: string[]; hits: number }> {
  const words = queryWords(query);
  if (!words.length) return [];
  const rows = db.prepare(`SELECT id, content, concepts_json FROM lane_pilot_memory WHERE project_id=? AND ${COLD}`).all(projectId) as Array<{ id: string; content: string; concepts_json: string }>;
  return rows.map((row) => ({ id: row.id, content: row.content, concepts: JSON.parse(row.concepts_json) as string[], hits: wordHits(`${row.content} ${row.concepts_json}`, words) }))
    .filter((row) => row.hits >= minHits(words)).sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Brings cold notes back: active again, used now, in the search indexes; the promotion is on record. */
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

export function episodes(db: Db, projectId: string, query: string, limit = 3): Episode[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const rows = db.prepare(`SELECT t.id AS task_id, t.contract_json, t.created_at,
      (SELECT a.state FROM lane_pilot_attempt a WHERE a.run_id=t.run_id AND a.task_id=t.id ORDER BY a.attempt_no DESC, a.updated_at DESC LIMIT 1) AS state,
      (SELECT a.reason FROM lane_pilot_attempt a WHERE a.run_id=t.run_id AND a.task_id=t.id ORDER BY a.attempt_no DESC, a.updated_at DESC LIMIT 1) AS reason
    FROM lane_pilot_task t JOIN lane_pilot_run r ON r.id=t.run_id WHERE r.project_id=? ORDER BY t.created_at DESC LIMIT 400`).all(projectId) as Array<{ task_id: string; contract_json: string; created_at: number; state: string | null; reason: string | null }>;
  return rows.flatMap((row) => {
    let contract: { title?: unknown; display_title?: unknown; objective?: unknown } = {};
    try { contract = JSON.parse(row.contract_json) as typeof contract; } catch { return []; }
    const title = String(contract.display_title || contract.title || row.task_id);
    const hits = wordHits(`${title} ${String(contract.objective ?? "")}`, words);
    return hits >= minHits(words) && row.state ? [{ episode: { taskId: row.task_id, title, state: row.state, reason: row.reason, at: row.created_at }, hits }] : [];
  }).sort((a, b) => b.hits - a.hits || b.episode.at - a.episode.at).slice(0, limit).map((row) => row.episode);
}

/** What the PM gets on top of the active notes: promoted cold notes and past tasks; a miss is recorded when nothing at all was found. */
export function enrichMemoryContext(db: Db, input: { projectId: string; query: string; activeCount: number; now?: number }): { text: string; promoted: string[]; episodes: number; miss: boolean } {
  const now = input.now ?? Date.now();
  const cold = input.activeCount < 3 ? coldMatches(db, input.projectId, input.query) : [];
  const promoted = cold.length ? (promote(db, input.projectId, cold, input.query, now), cold) : [];
  const past = episodes(db, input.projectId, input.query);
  const miss = input.activeCount === 0 && !promoted.length && !past.length;
  if (miss) db.prepare("INSERT INTO lane_pilot_memory_miss(project_id,query,at) VALUES (?,?,?)").run(input.projectId, input.query.slice(0, 1000), now);
  const parts = [
    promoted.length ? ["Notes brought back from the cold tier (unused for 90 days, needed again now):", ...promoted.map((note) => `- ${note.content.replace(/\s+/g, " ").trim()}`)].join("\n") : "",
    episodeLines(past),
  ].filter(Boolean);
  return { text: parts.join("\n\n"), promoted: promoted.map((note) => note.id), episodes: past.length, miss };
}

/** The tiers at a glance: the cold tier's size, how many of it were needed again, and the latest misses. */
export function tierReport(db: Db, projectId?: string, now = Date.now()) {
  const where = projectId ? "AND project_id=?" : "", args = projectId ? [projectId] : [];
  const cold = (db.prepare(`SELECT count(*) AS n FROM lane_pilot_memory WHERE ${COLD} ${where}`).get(...args) as { n: number }).n;
  const promoted = (db.prepare(`SELECT count(DISTINCT project_id||memory_id) AS n FROM lane_pilot_memory_promotion WHERE 1=1 ${where}`).get(...args) as { n: number }).n;
  const misses = db.prepare(`SELECT project_id AS projectId, query, at FROM lane_pilot_memory_miss WHERE at>=? ${where} ORDER BY at DESC LIMIT 50`).all(now - 30 * 86_400_000, ...args);
  return { cold, promoted, neededAgainShare: cold + promoted ? Math.round((promoted / (cold + promoted)) * 1000) / 1000 : null, misses };
}
