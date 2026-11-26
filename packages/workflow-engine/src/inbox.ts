import type Database from "better-sqlite3";

/**
 * Append-only durable event inbox for workflow triggers and waiting steps.
 * Appended at the end of `src/rooms/migrations.ts` (positional, never reordered).
 */
export const workflowInboxMigrations: string[] = [
  `CREATE TABLE lane_pilot_wf_inbox (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    consumed_by TEXT
  );
  CREATE INDEX lane_pilot_wf_inbox_pending ON lane_pilot_wf_inbox(name, key, consumed_by)`,
];

export type InboxEventRow = {
  id: string;
  name: string;
  key: string;
  payload_json: string;
  created_at: number;
  consumed_by: string | null;
};

export type InboxEvent = {
  id: string;
  name: string;
  key: string;
  payload: Record<string, unknown>;
  createdAt: number;
  consumedBy: string | null;
};

type InboxDb = Pick<Database.Database, "prepare" | "transaction">;

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Inserts an event into the inbox (insert-or-ignore by idempotency id). Returns false if duplicate. */
export function insertInboxEvent(
  db: Pick<Database.Database, "prepare">,
  input: { id: string; name: string; key: string; payload: Record<string, unknown>; createdAt: number },
): boolean {
  const result = db.prepare(
    "INSERT OR IGNORE INTO lane_pilot_wf_inbox (id, name, key, payload_json, created_at, consumed_by) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(input.id, input.name, input.key, JSON.stringify(input.payload), input.createdAt);
  return result.changes > 0;
}

/** Marks an inbox event consumed if it has not been consumed yet. */
export function markInboxEventConsumed(
  db: Pick<Database.Database, "prepare">,
  id: string,
  consumedBy: string,
): boolean {
  const result = db.prepare("UPDATE lane_pilot_wf_inbox SET consumed_by=? WHERE id=? AND consumed_by IS NULL").run(consumedBy, id);
  return result.changes > 0;
}

/**
 * Attempt fencing: if the waiting step declares an attemptKey, only an event carrying that exact attemptKey matches;
 * if the event carries an attemptKey and the run is linked to an attempt, they must match as well.
 */
export function attemptMatches(
  stepAttemptKey: string | undefined,
  runAttemptId: string | undefined,
  eventAttemptKey: string | undefined,
): boolean {
  if (stepAttemptKey !== undefined) return eventAttemptKey === stepAttemptKey;
  if (eventAttemptKey !== undefined && runAttemptId !== undefined) return eventAttemptKey === runAttemptId;
  return true;
}

/** Atomically claims the oldest unconsumed inbox event matching `(name, key)` and `accept`, or null. */
export function claimUnconsumedInboxEvent(
  db: InboxDb,
  input: {
    name: string;
    key: string;
    consumedBy: string;
    accept?: (payload: Record<string, unknown>) => boolean;
  },
): InboxEvent | null {
  return db.transaction(() => {
    const rows = db.prepare(
      "SELECT id, name, key, payload_json, created_at, consumed_by FROM lane_pilot_wf_inbox WHERE name=? AND key=? AND consumed_by IS NULL ORDER BY rowid ASC",
    ).all(input.name, input.key) as InboxEventRow[];
    for (const row of rows) {
      const payload = parsePayload(row.payload_json);
      if (input.accept && !input.accept(payload)) continue;
      const updated = db.prepare("UPDATE lane_pilot_wf_inbox SET consumed_by=? WHERE id=? AND consumed_by IS NULL").run(input.consumedBy, row.id);
      if (updated.changes === 0) continue;
      return {
        id: row.id,
        name: row.name,
        key: row.key,
        payload,
        createdAt: row.created_at,
        consumedBy: input.consumedBy,
      };
    }
    return null;
  })();
}

/** Link columns of a workflow run (project, Lane Pilot run, task, attempt). */
export function wfRunLinkOf(db: Parameters<typeof insertInboxEvent>[0], wfRunId: string): { link_run_id: string | null; link_task_id: string | null; link_attempt_id: string | null; project_id: string | null } | null {
  return ((db as { prepare(sql: string): { get(id: string): unknown } }).prepare("SELECT link_run_id, link_task_id, link_attempt_id, project_id FROM lane_pilot_wf_run WHERE id=?")
    .get(wfRunId) as { link_run_id: string | null; link_task_id: string | null; link_attempt_id: string | null; project_id: string | null } | undefined) ?? null;
}
