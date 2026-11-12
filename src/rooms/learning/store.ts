import type Database from "better-sqlite3";
import { sha256Hex } from "@lane-pilot/kit";

export type Db = Pick<Database.Database, "prepare">;
export const DAY_MS = 86_400_000;
export const startOfDay = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS;

export type ObsState = "skipped" | "observed" | "candidate" | "extracted" | "ignored";
/**
 * One owner message the hook saw. The table also has the columns of the old judges (Jev, the second opinion, the review marks); they
 * stay in old rows and are never written now, since migrations are append only.
 */
export type Observation = {
  id: string; threadId: string; projectId: string; at: number; judgedAt: number; source: "live" | "catchup"; chars: number;
  excerpt: string | null; state: ObsState; skipReason: string | null; sensitive: boolean;
  body: string | null; prev: string | null;
};

type Row = Record<string, unknown>;
const COLUMNS = ["id", "thread_id", "project_id", "at", "judged_at", "source", "chars", "excerpt", "state", "skip_reason", "sensitive", "body", "prev"] as const;

const fromRow = (row: Row): Observation => ({
  id: row.id as string, threadId: row.thread_id as string, projectId: row.project_id as string, at: row.at as number, judgedAt: row.judged_at as number,
  source: row.source as "live" | "catchup", chars: row.chars as number, excerpt: (row.excerpt as string | null) ?? null, state: row.state as ObsState,
  skipReason: (row.skip_reason as string | null) ?? null, sensitive: row.sensitive === 1,
  body: (row.body as string | null) ?? null, prev: (row.prev as string | null) ?? null,
});

/** Stores one observation; false when the message was already seen (a message reaches the hook more than once). */
export function insertObservation(db: Db, o: Observation): boolean {
  const values: Record<string, unknown> = {
    id: o.id, thread_id: o.threadId, project_id: o.projectId, at: o.at, judged_at: o.judgedAt, source: o.source, chars: o.chars, excerpt: o.excerpt, state: o.state,
    skip_reason: o.skipReason, sensitive: o.sensitive ? 1 : 0, body: o.body, prev: o.prev,
  };
  return db.prepare(`INSERT OR IGNORE INTO lane_pilot_learning_obs (${COLUMNS.join(",")}) VALUES (${COLUMNS.map((c) => `@${c}`).join(",")})`).run(values).changes === 1;
}

export const hasObservation = (db: Db, id: string): boolean => Boolean(db.prepare("SELECT 1 FROM lane_pilot_learning_obs WHERE id=?").get(id));
export const getObservation = (db: Db, id: string): Observation | null => {
  const row = db.prepare("SELECT * FROM lane_pilot_learning_obs WHERE id=?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
};

/** How many candidates were kept today (UTC day), against the daily cap. */
export function usageToday(db: Db, now: number): { candidates: number } {
  const row = db.prepare("SELECT count(*) AS n FROM lane_pilot_learning_obs WHERE judged_at>=? AND state IN ('candidate','extracted','ignored')").get(startOfDay(now)) as { n: number };
  return { candidates: row.n };
}

export function candidatesOf(db: Db, projectId: string, limit: number): Observation[] {
  return (db.prepare("SELECT * FROM lane_pilot_learning_obs WHERE state='candidate' AND project_id=? AND body IS NOT NULL ORDER BY at LIMIT ?").all(projectId, limit) as Row[]).map(fromRow);
}

/** Projects with candidates waiting, the oldest first, and how many. */
export function projectsWithCandidates(db: Db): Array<{ projectId: string; waiting: number; oldest: number }> {
  return (db.prepare("SELECT project_id AS projectId, count(*) AS waiting, min(at) AS oldest FROM lane_pilot_learning_obs WHERE state='candidate' AND body IS NOT NULL GROUP BY project_id ORDER BY oldest").all() as Array<{ projectId: string; waiting: number; oldest: number }>);
}

/** A candidate has been read by the extractor (or given up on): its text is no longer kept. */
export function finishCandidates(db: Db, ids: readonly string[], state: "extracted" | "ignored"): void {
  const update = db.prepare("UPDATE lane_pilot_learning_obs SET state=?, body=NULL, prev=NULL WHERE id=? AND state='candidate'");
  for (const id of ids) update.run(state, id);
}

/** Texts that waited a day and a half (the night pass reads a whole day) without being read are dropped; the observation (its judgments) stays. */
export function purgeStaleBodies(db: Db, now: number, keepMs = 36 * 3_600_000): number {
  return db.prepare("UPDATE lane_pilot_learning_obs SET body=NULL, prev=NULL, state=CASE WHEN state='candidate' THEN 'ignored' ELSE state END, skip_reason=CASE WHEN state='candidate' THEN 'unread' ELSE skip_reason END WHERE (body IS NOT NULL OR prev IS NOT NULL) AND judged_at<?").run(now - keepMs).changes;
}

/* ---- items ---- */

export type ItemKind = "rule" | "preference" | "decision" | "deadline" | "fact";
export type ItemState = "adopted" | "proposed" | "pending_owner" | "accepted" | "duplicate" | "rejected" | "dropped" | "noted";
export type Item = {
  id: string; obsId: string; projectId: string; threadId: string; kind: ItemKind; text: string; audience: string | null; reach: string; dueAt: number | null;
  state: ItemState; target: string | null; evidence: string; duplicateOf: string | null; confirmations: number; note: string | null;
  createdAt: number; decidedAt: number | null; announcedAt: number | null;
};

const itemFrom = (row: Row): Item => ({
  id: row.id as string, obsId: row.obs_id as string, projectId: row.project_id as string, threadId: row.thread_id as string, kind: row.kind as ItemKind, text: row.text as string,
  audience: (row.audience as string | null) ?? null, reach: row.reach as string, dueAt: (row.due_at as number | null) ?? null, state: row.state as ItemState,
  target: (row.target as string | null) ?? null, evidence: row.evidence as string, duplicateOf: (row.duplicate_of as string | null) ?? null, confirmations: row.confirmations as number,
  note: (row.note as string | null) ?? null, createdAt: row.created_at as number, decidedAt: (row.decided_at as number | null) ?? null, announcedAt: (row.announced_at as number | null) ?? null,
});

export const itemId = (obsId: string, kind: string, text: string): string => `lrn_${sha256Hex(`${obsId}\n${kind}\n${text.toLowerCase()}`).slice(0, 12)}`;

/** An item with no evidence is refused here, whatever the caller did: every record names the message it came from. */
export function insertItem(db: Db, item: Item): boolean {
  if (!item.evidence.trim() || !item.obsId.trim()) throw new Error("a learned item needs evidence: the id of the owner message");
  return db.prepare(`INSERT OR IGNORE INTO lane_pilot_learning_item (id,obs_id,project_id,thread_id,kind,text,audience,reach,due_at,state,target,evidence,duplicate_of,confirmations,note,created_at,decided_at,announced_at)
    VALUES (@id,@obsId,@projectId,@threadId,@kind,@text,@audience,@reach,@dueAt,@state,@target,@evidence,@duplicateOf,@confirmations,@note,@createdAt,@decidedAt,@announcedAt)`).run(item).changes === 1;
}

export const getItem = (db: Db, id: string): Item | null => {
  const row = db.prepare("SELECT * FROM lane_pilot_learning_item WHERE id=?").get(id) as Row | undefined;
  return row ? itemFrom(row) : null;
};

export function listItems(db: Db, filter: { projectId?: string; states?: readonly ItemState[]; kinds?: readonly ItemKind[]; unannounced?: boolean; since?: number; limit?: number } = {}): Item[] {
  const where: string[] = [], args: unknown[] = [];
  if (filter.projectId) { where.push("project_id=?"); args.push(filter.projectId); }
  if (filter.states?.length) { where.push(`state IN (${filter.states.map(() => "?").join(",")})`); args.push(...filter.states); }
  if (filter.kinds?.length) { where.push(`kind IN (${filter.kinds.map(() => "?").join(",")})`); args.push(...filter.kinds); }
  if (filter.unannounced) where.push("announced_at IS NULL");
  if (filter.since !== undefined) { where.push("created_at>=?"); args.push(filter.since); }
  return (db.prepare(`SELECT * FROM lane_pilot_learning_item ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`).all(...args, Math.min(filter.limit ?? 50, 500)) as Row[]).map(itemFrom);
}

export function setItemState(db: Db, id: string, patch: { state: ItemState; target?: string | null; note?: string | null }, now: number): boolean {
  return db.prepare("UPDATE lane_pilot_learning_item SET state=?, target=COALESCE(?,target), note=COALESCE(?,note), decided_at=? WHERE id=?").run(patch.state, patch.target ?? null, patch.note ?? null, now, id).changes === 1;
}

export const markAnnounced = (db: Db, ids: readonly string[], now: number): void => {
  const update = db.prepare("UPDATE lane_pilot_learning_item SET announced_at=? WHERE id=? AND announced_at IS NULL");
  for (const id of ids) update.run(now, id);
};

export const bumpItem = (db: Db, id: string): void => { db.prepare("UPDATE lane_pilot_learning_item SET confirmations=confirmations+1 WHERE id=?").run(id); };

/** Reviewed non-sensitive observations of a window (the policy live exam's labeled rows). */
export function listReviewedObservations(db: Db, since: number): Array<{ id: string; review: "ok" | "wrong"; reviewed_at: number; kind: string | null; final_route: string | null; excerpt: string | null }> {
  return db.prepare("SELECT id, review, reviewed_at, kind, final_route, excerpt FROM lane_pilot_learning_obs WHERE review IN ('ok','wrong') AND sensitive=0 AND reviewed_at>? ORDER BY reviewed_at")
    .all(since) as Array<{ id: string; review: "ok" | "wrong"; reviewed_at: number; kind: string | null; final_route: string | null; excerpt: string | null }>;
}

/** Correction/frustration observations judged since a time, oldest first (the replay harvest reads the raw columns). */
export function judgedCorrectionRows(db: Db, sinceMs: number, limit: number): Array<{ id: string; thread_id: string; project_id: string; at: number; excerpt: string | null; body: string | null; prev: string | null; kind: string; frustration: number | null }> {
  return db.prepare(`SELECT id, thread_id, project_id, at, excerpt, body, prev, kind, frustration FROM lane_pilot_learning_obs
    WHERE judged_at>=? AND (kind='correction' OR frustration>=0.5) ORDER BY at LIMIT ?`).all(sinceMs, limit) as
    Array<{ id: string; thread_id: string; project_id: string; at: number; excerpt: string | null; body: string | null; prev: string | null; kind: string; frustration: number | null }>;
}

/** Whether the thread is recorded in the learning observations or items (the memory thread gate's learning half). */
export function learningThreadRecorded(db: Db, threadId: string): boolean {
  const row = db.prepare(`SELECT (
    EXISTS(SELECT 1 FROM lane_pilot_learning_obs WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_learning_item WHERE thread_id=?)
  ) AS hit`).get(threadId, threadId) as { hit: number };
  return row.hit === 1;
}

/** Items waiting on the owner's decision, newest first (the owner-waiting morning list, handed over as a Services reader). */
export function pendingOwnerLearningItems(db: Db): Array<{ id: string; project_id: string; kind: string; text: string; evidence: string; created_at: number }> {
  return db.prepare("SELECT id, project_id, kind, text, evidence, created_at FROM lane_pilot_learning_item WHERE state='pending_owner' ORDER BY created_at DESC").all() as
    Array<{ id: string; project_id: string; kind: string; text: string; evidence: string; created_at: number }>;
}

/* ---- history search (SMA k_lib_history): raw rows the memory-tiers ranker reads ---- */

/** Transcript fragments of a project for the history search; sensitive observations stay out. */
export function historyObservations(db: Db, projectId: string, limit = 400): Array<{ id: string; excerpt: string | null; body: string | null; at: number }> {
  return db.prepare("SELECT id, excerpt, body, at FROM lane_pilot_learning_obs WHERE project_id=? AND sensitive=0 ORDER BY at DESC LIMIT ?")
    .all(projectId, limit) as Array<{ id: string; excerpt: string | null; body: string | null; at: number }>;
}

/** Learned items of a project for the history search (the lessons book). */
export function historyItems(db: Db, projectId: string, limit = 400): Array<{ id: string; kind: string; text: string; at: number }> {
  return db.prepare("SELECT id, kind, text, created_at AS at FROM lane_pilot_learning_item WHERE project_id=? ORDER BY created_at DESC LIMIT ?")
    .all(projectId, limit) as Array<{ id: string; kind: string; text: string; at: number }>;
}
