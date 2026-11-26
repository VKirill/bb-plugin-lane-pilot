import type Database from "better-sqlite3";
import { clip } from "@lane-pilot/contracts";
import type { OpenOwnerItemFilter, PostOwnerItem } from "../../models/owner-item";

type Db = Pick<Database.Database, "prepare">;

/**
 * A room whose rows sit on the owner's list answers «janitor:<why>» when the row's question is gone (the writer's task moved on, the
 * run closed, the schedule paused or gone), null while it still stands. The sweep calls the probe for every open row; the probe keeps
 * its own table query, so the room's key format and schema change in one place.
 */
export type OwnerItemSweep = (db: Pick<Database.Database, "prepare">, item: { key: string; kind: string; created_at: number }) => string | null;

export const tableExists = (db: Db, name: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

export type RawOpenOwnerItemRow = {
  key: string;
  source: string;
  kind: string;
  project_id: string | null;
  what: string;
  why: string;
  evidence_json: string;
  actions_json: string;
  wake: number;
  created_at: number;
};

export function listOpenOwnerItemRows(db: Db): RawOpenOwnerItemRow[] {
  if (!tableExists(db, "lane_pilot_owner_item")) return [];
  return db
    .prepare("SELECT key, source, kind, project_id, what, why, evidence_json, actions_json, wake, created_at FROM lane_pilot_owner_item WHERE state='open' ORDER BY created_at")
    .all() as RawOpenOwnerItemRow[];
}

export function upsertOwnerItem(db: Db, item: PostOwnerItem, now: number): boolean {
  // The same key twice: a row the owner answered stays closed (his word stands); a row the system closed — the janitor's term, a run
  // goal that went green, a profile check that went green — is a new question when it comes back, so it reopens with the new text
  // (SWE-2 verification N-002: a closed key was a tombstone, and a second product question on the same task was dropped without a row).
  const result = db.prepare(`INSERT INTO lane_pilot_owner_item(key,source,kind,project_id,what,why,evidence_json,actions_json,wake,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,'open',?)
    ON CONFLICT(key) DO UPDATE SET source=excluded.source, kind=excluded.kind, project_id=excluded.project_id, what=excluded.what, why=excluded.why,
      evidence_json=excluded.evidence_json, actions_json=excluded.actions_json, wake=excluded.wake, state='open', created_at=excluded.created_at, closed_at=NULL, closed_by=NULL
    WHERE lane_pilot_owner_item.state='closed' AND (lane_pilot_owner_item.closed_by LIKE 'janitor:%' OR lane_pilot_owner_item.closed_by LIKE 'run-goal:%' OR lane_pilot_owner_item.closed_by LIKE 'profile-check:%')`)
    .run(
      item.key,
      item.source,
      item.kind,
      item.projectId ?? null,
      clip(item.what, 600),
      clip(item.why, 600),
      JSON.stringify(item.evidence ?? []),
      JSON.stringify(item.actions ?? []),
      item.wake === false ? 0 : 1,
      now,
    );
  return result.changes > 0;
}

/** The owner answered (or the thing went away): the row leaves the screen and the digest. */
export function closeOwnerItem(db: Db, key: string, by: string, now: number = Date.now()): boolean {
  return db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_at=?, closed_by=? WHERE key=? AND state='open'").run(now, clip(by, 500), key).changes > 0;
}

/** Did a person (or the agent deciding for him) close this row? A row the system closed — the janitor, a goal gone green — is not his answer. */
export function ownerAnsweredItem(db: Db, key: string): boolean {
  const row = db.prepare("SELECT closed_by FROM lane_pilot_owner_item WHERE key=? AND state='closed'").get(key) as { closed_by: string | null } | undefined;
  return !!row?.closed_by && !/^(janitor|run-goal|profile-check):/.test(row.closed_by);
}

/** Every open row under a key prefix (a question asked once per attempt: `task-word:<run>:<family>:`); returns how many closed. */
export function closeOwnerItemsByPrefix(db: Db, prefix: string, by: string, now: number = Date.now()): number {
  return db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_at=?, closed_by=? WHERE state='open' AND substr(key, 1, ?)=?").run(now, clip(by, 500), prefix.length, prefix).changes;
}

/** A decided owner item under a key prefix (closed approved:* or returned:*): the answer that already stands, or null. */
export function decidedOwnerItem(db: Db, prefix: string): { key: string; by: string; at: number } | null {
  const row = db.prepare("SELECT key, closed_by AS by, closed_at AS at FROM lane_pilot_owner_item WHERE state='closed' AND substr(key, 1, ?)=? AND (closed_by LIKE 'approved:%' OR closed_by LIKE 'returned:%') ORDER BY closed_at DESC LIMIT 1")
    .get(prefix.length, prefix) as { key: string; by: string | null; at: number | null } | undefined;
  return row?.by ? { key: row.key, by: row.by, at: row.at ?? 0 } : null;
}

/** How many rows already exist under a key prefix — the next episode's sequence number, so a repost after a close is a fresh row. */
export function ownerItemPrefixCount(db: Db, prefix: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_owner_item WHERE substr(key, 1, ?)=?").get(prefix.length, prefix) as { n: number }).n;
}

const openOwnerItemWhere = (filter: OpenOwnerItemFilter): { where: string; params: unknown[] } => {
  const where = ["state='open'"], params: unknown[] = [];
  if (filter.key !== undefined) { where.push("key=?"); params.push(filter.key); }
  if (filter.source !== undefined) { where.push("source=?"); params.push(filter.source); }
  if (filter.kind !== undefined) { where.push("kind=?"); params.push(filter.kind); }
  if (filter.projectId !== undefined) { where.push("project_id=?"); params.push(filter.projectId); }
  if (filter.since !== undefined) { where.push("created_at>?"); params.push(filter.since); }
  return { where: where.join(" AND "), params };
};

export function hasOpenOwnerItem(db: Db, filter: OpenOwnerItemFilter): boolean {
  const { where, params } = openOwnerItemWhere(filter);
  return db.prepare(`SELECT 1 FROM lane_pilot_owner_item WHERE ${where} LIMIT 1`).get(...params) !== undefined;
}

export function countOpenOwnerItems(db: Db, filter: OpenOwnerItemFilter): number {
  const { where, params } = openOwnerItemWhere(filter);
  return (db.prepare(`SELECT COUNT(*) AS n FROM lane_pilot_owner_item WHERE ${where}`).get(...params) as { n: number }).n;
}

export function listOpenOwnerItemKeys(db: Db, filter: OpenOwnerItemFilter): string[] {
  const { where, params } = openOwnerItemWhere(filter);
  return (db.prepare(`SELECT key FROM lane_pilot_owner_item WHERE ${where}`).all(...params) as Array<{ key: string }>).map((row) => row.key);
}

export function listOpenOwnerItems(
  db: Db,
  filter: OpenOwnerItemFilter,
): Array<{ key: string; source: string; kind: string; projectId: string | null; what: string; why: string; createdAt: number }> {
  if (!tableExists(db, "lane_pilot_owner_item")) return [];
  const { where, params } = openOwnerItemWhere(filter);
  return db
    .prepare(
      `SELECT key, source, kind, project_id AS projectId, what, why, created_at AS createdAt
         FROM lane_pilot_owner_item
        WHERE ${where}
        ORDER BY created_at DESC`,
    )
    .all(...params) as Array<{
    key: string;
    source: string;
    kind: string;
    projectId: string | null;
    what: string;
    why: string;
    createdAt: number;
  }>;
}

export function listOpenItemsForSweep(db: Db): Array<{ key: string; kind: string; actions_json: string; created_at: number }> {
  if (!tableExists(db, "lane_pilot_owner_item")) return [];
  return db.prepare("SELECT key, kind, actions_json, created_at FROM lane_pilot_owner_item WHERE state='open'").all() as Array<{
    key: string;
    kind: string;
    actions_json: string;
    created_at: number;
  }>;
}

const countQuery = (db: Db, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;

export function countOpenInboxItems(db: Db): number {
  return countQuery(db, "SELECT count(*) AS n FROM lane_pilot_owner_item WHERE state='open'");
}

export function countAcceptedAttemptsSince(db: Db, since: number): number {
  return countQuery(db, "SELECT count(*) AS n FROM lane_pilot_attempt WHERE state='accepted' AND updated_at>=?", since);
}

export function listClosedByCountsSince(db: Db, since: number): Array<{ by: string | null; n: number }> {
  if (!tableExists(db, "lane_pilot_owner_item")) return [];
  return db
    .prepare("SELECT closed_by AS by, count(*) AS n FROM lane_pilot_owner_item WHERE state='closed' AND closed_at>=? GROUP BY closed_by")
    .all(since) as Array<{ by: string | null; n: number }>;
}
