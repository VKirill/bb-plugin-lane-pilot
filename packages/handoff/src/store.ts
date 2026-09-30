import type Database from "better-sqlite3";
import {
  canTransition,
  handoffCardSchema,
  isTerminalHandoffState,
  type HandoffCard,
  type HandoffCardDraft,
  type HandoffReceipt,
  type HandoffState,
} from "./contract";

export type HandoffDatabase = Pick<Database.Database, "prepare" | "transaction">;

/** Appended by the host plugin to its own migration list; never renumbered. */
export const handoffMigrations: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lane_pilot_handoff (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    run_id TEXT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    owner_thread_id TEXT,
    recipient_thread_id TEXT,
    state TEXT NOT NULL,
    card_json TEXT NOT NULL,
    receipt_json TEXT,
    lease_holder TEXT,
    lease_expires_at INTEGER,
    deadline_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS lane_pilot_handoff_project ON lane_pilot_handoff(project_id, state, updated_at)`,
  `CREATE TABLE IF NOT EXISTS lane_pilot_handoff_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handoff_id TEXT NOT NULL REFERENCES lane_pilot_handoff(id) ON DELETE CASCADE,
    from_state TEXT,
    to_state TEXT NOT NULL,
    actor TEXT NOT NULL,
    note TEXT,
    occurred_at INTEGER NOT NULL
  )`,
];

type Row = {
  id: string;
  project_id: string;
  run_id: string | null;
  owner_thread_id: string | null;
  recipient_thread_id: string | null;
  state: HandoffState;
  card_json: string;
  receipt_json: string | null;
  lease_holder: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export type HandoffLease = { holder: string; expiresAt: number };

export type StoredHandoff = {
  card: HandoffCard;
  receipt: HandoffReceipt | null;
  lease: HandoffLease | null;
};

function rowToStored(row: Row): StoredHandoff {
  const draft = JSON.parse(row.card_json) as HandoffCardDraft;
  const card = handoffCardSchema.parse({
    ...draft,
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    ownerThreadId: row.owner_thread_id,
    recipientThreadId: row.recipient_thread_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const lease = row.lease_holder && row.lease_expires_at !== null ? { holder: row.lease_holder, expiresAt: row.lease_expires_at } : null;
  return { card, receipt: row.receipt_json ? (JSON.parse(row.receipt_json) as HandoffReceipt) : null, lease };
}

const SELECT = "SELECT id,project_id,run_id,owner_thread_id,recipient_thread_id,state,card_json,receipt_json,lease_holder,lease_expires_at,created_at,updated_at FROM lane_pilot_handoff";

function appendEvent(db: HandoffDatabase, input: { handoffId: string; from: HandoffState | null; to: HandoffState; actor: string; note?: string; now: number }): void {
  db.prepare("INSERT INTO lane_pilot_handoff_event(handoff_id,from_state,to_state,actor,note,occurred_at) VALUES(?,?,?,?,?,?)")
    .run(input.handoffId, input.from, input.to, input.actor, input.note ?? null, input.now);
}

export function createHandoff(db: HandoffDatabase, input: {
  id: string;
  projectId: string;
  runId?: string | null;
  ownerThreadId?: string | null;
  draft: HandoffCardDraft;
  now?: number;
}): StoredHandoff {
  const now = input.now ?? Date.now();
  return db.transaction(() => {
    db.prepare(`INSERT INTO lane_pilot_handoff(id,project_id,run_id,from_agent,to_agent,owner_thread_id,recipient_thread_id,state,card_json,deadline_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,NULL,'queued',?,?,?,?)`)
      .run(input.id, input.projectId, input.runId ?? null, input.draft.fromAgent, input.draft.toAgent, input.ownerThreadId ?? null, JSON.stringify(input.draft), input.draft.deadlineAt, now, now);
    appendEvent(db, { handoffId: input.id, from: null, to: "queued", actor: input.draft.fromAgent, now });
    return getHandoff(db, input.id)!;
  }).immediate();
}

export function getHandoff(db: HandoffDatabase, id: string): StoredHandoff | null {
  const row = db.prepare(`${SELECT} WHERE id=?`).get(id) as Row | undefined;
  return row ? rowToStored(row) : null;
}

export function listHandoffs(db: HandoffDatabase, filter: { projectId: string; runId?: string; states?: readonly HandoffState[]; limit?: number }): StoredHandoff[] {
  const where = ["project_id=?"];
  const params: unknown[] = [filter.projectId];
  if (filter.runId) { where.push("run_id=?"); params.push(filter.runId); }
  if (filter.states && filter.states.length > 0) {
    where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
    params.push(...filter.states);
  }
  params.push(Math.min(Math.max(filter.limit ?? 100, 1), 1000));
  const rows = db.prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`).all(...params) as Row[];
  return rows.map(rowToStored);
}

export type TransitionResult = { ok: true; handoff: StoredHandoff } | { ok: false; reason: "not_found" | "illegal_transition"; from?: HandoffState };

export function transitionHandoff(db: HandoffDatabase, input: {
  id: string;
  to: HandoffState;
  actor: string;
  note?: string;
  recipientThreadId?: string;
  now?: number;
}): TransitionResult {
  const now = input.now ?? Date.now();
  return db.transaction((): TransitionResult => {
    const current = getHandoff(db, input.id);
    if (!current) return { ok: false, reason: "not_found" };
    const from = current.card.state;
    if (!canTransition(from, input.to)) return { ok: false, reason: "illegal_transition", from };
    db.prepare("UPDATE lane_pilot_handoff SET state=?, recipient_thread_id=COALESCE(?,recipient_thread_id), updated_at=? WHERE id=?")
      .run(input.to, input.recipientThreadId ?? null, now, input.id);
    if (isTerminalHandoffState(input.to)) {
      db.prepare("UPDATE lane_pilot_handoff SET lease_holder=NULL, lease_expires_at=NULL WHERE id=?").run(input.id);
    }
    appendEvent(db, { handoffId: input.id, from, to: input.to, actor: input.actor, note: input.note, now });
    return { ok: true, handoff: getHandoff(db, input.id)! };
  }).immediate();
}

/** Stores the recipient's receipt and moves the card to the state the receipt names. */
export function recordHandoffReceipt(db: HandoffDatabase, input: { id: string; receipt: HandoffReceipt; actor: string; now?: number }): TransitionResult {
  const now = input.now ?? Date.now();
  return db.transaction((): TransitionResult => {
    const current = getHandoff(db, input.id);
    if (!current) return { ok: false, reason: "not_found" };
    // A recipient may answer straight from `delivered` or `accepted`; the card passes through in_progress first.
    if (current.card.state === "delivered") {
      const accepted = transitionHandoff(db, { id: input.id, to: "accepted", actor: input.actor, now });
      if (!accepted.ok) return accepted;
    }
    const afterAccept = getHandoff(db, input.id)!;
    if (afterAccept.card.state === "accepted") {
      const started = transitionHandoff(db, { id: input.id, to: "in_progress", actor: input.actor, now });
      if (!started.ok) return started;
    }
    db.prepare("UPDATE lane_pilot_handoff SET receipt_json=?, updated_at=? WHERE id=?").run(JSON.stringify(input.receipt), now, input.id);
    return transitionHandoff(db, { id: input.id, to: input.receipt.status, actor: input.actor, note: input.receipt.summary.slice(0, 500), now });
  }).immediate();
}

export type LeaseResult = { ok: true; lease: HandoffLease } | { ok: false; reason: "not_found" | "held_by_other" | "terminal"; holder?: string };

export function claimHandoffLease(db: HandoffDatabase, input: { id: string; holder: string; leaseMs: number; now?: number }): LeaseResult {
  const now = input.now ?? Date.now();
  return db.transaction((): LeaseResult => {
    const current = getHandoff(db, input.id);
    if (!current) return { ok: false, reason: "not_found" };
    if (isTerminalHandoffState(current.card.state)) return { ok: false, reason: "terminal" };
    const lease = current.lease;
    if (lease && lease.holder !== input.holder && lease.expiresAt > now) return { ok: false, reason: "held_by_other", holder: lease.holder };
    const expiresAt = now + Math.max(1, input.leaseMs);
    db.prepare("UPDATE lane_pilot_handoff SET lease_holder=?, lease_expires_at=?, updated_at=? WHERE id=?").run(input.holder, expiresAt, now, input.id);
    return { ok: true, lease: { holder: input.holder, expiresAt } };
  }).immediate();
}

export function renewHandoffLease(db: HandoffDatabase, input: { id: string; holder: string; leaseMs: number; now?: number }): LeaseResult {
  const now = input.now ?? Date.now();
  const current = getHandoff(db, input.id);
  if (!current) return { ok: false, reason: "not_found" };
  if (!current.lease || current.lease.holder !== input.holder) return { ok: false, reason: "held_by_other", holder: current.lease?.holder };
  return claimHandoffLease(db, { ...input, now });
}

export function releaseHandoffLease(db: HandoffDatabase, input: { id: string; holder: string; now?: number }): boolean {
  const now = input.now ?? Date.now();
  const result = db.prepare("UPDATE lane_pilot_handoff SET lease_holder=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND lease_holder=?").run(now, input.id, input.holder);
  return result.changes > 0;
}

/** Cards past their deadline that nobody finished become `expired`; returns their ids. */
export function expireOverdueHandoffs(db: HandoffDatabase, now = Date.now(), actor = "scheduler"): string[] {
  return db.transaction(() => {
    const rows = db.prepare("SELECT id, state FROM lane_pilot_handoff WHERE deadline_at IS NOT NULL AND deadline_at < ? AND state IN ('queued','delivered','accepted','in_progress')").all(now) as Array<{ id: string; state: HandoffState }>;
    const expired: string[] = [];
    for (const row of rows) {
      const result = transitionHandoff(db, { id: row.id, to: "expired", actor, note: "deadline passed", now });
      if (result.ok) expired.push(row.id);
    }
    return expired;
  }).immediate();
}

export function listHandoffEvents(db: HandoffDatabase, handoffId: string): Array<{ from: HandoffState | null; to: HandoffState; actor: string; note: string | null; occurredAt: number }> {
  const rows = db.prepare("SELECT from_state,to_state,actor,note,occurred_at FROM lane_pilot_handoff_event WHERE handoff_id=? ORDER BY id ASC").all(handoffId) as Array<{ from_state: HandoffState | null; to_state: HandoffState; actor: string; note: string | null; occurred_at: number }>;
  return rows.map((row) => ({ from: row.from_state, to: row.to_state, actor: row.actor, note: row.note, occurredAt: row.occurred_at }));
}
