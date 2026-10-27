import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DueSource } from "./due";

export type DeferralDb = Pick<Database.Database, "prepare">;

export const DEFERRAL_KINDS = ["drill_scenario", "skipped_test", "gate", "plan_decision", "memory_conflict", "wall"] as const;
export type DeferralKind = (typeof DEFERRAL_KINDS)[number];
export type DeferralState = "open" | "overdue" | "closed" | "needs_owner_term";

/** Where the term came from: the owner's message, by thread, event sequence, the checked text's hash and the message's own time. */
export type OwnerRef = { threadId: string; seq: number; index: number; sha256: string; at: number };

export type Deferral = {
  id: string; projectId: string | null; what: string; kind: DeferralKind; area: string;
  dueAt: number | null; dueSource: DueSource | null; ownerRef: OwnerRef | null; ownerQuote: string | null;
  state: DeferralState; history: Array<{ dueAt: number | null; dueSource: string | null; ownerRef: OwnerRef | null; at: number }>;
  source: string; createdAt: number; updatedAt: number; closedAt: number | null; closedBy: string | null;
};

type Raw = {
  id: string; project_id: string | null; what: string; kind: DeferralKind; area: string; due_at: number | null; due_source: DueSource | null;
  owner_ref: string | null; owner_quote: string | null; state: DeferralState; history_json: string; source: string;
  created_at: number; updated_at: number; closed_at: number | null; closed_by: string | null;
};

const json = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

/**
 * Only a human sets the term of a mandatory check (Matvey Maslov, rule 5): a date from the owner's own message. A term the code gave
 * (`default_14d`) or an agent set (`agent`) is no term, so an entry holding only that is «open, no term»: it has no due date, never turns
 * overdue and counts as unproven in the phases of its project (`noTermDeferralsOf`). Rows written before this rule are read by it, not rewritten.
 */
export const HUMAN_TERM_SQL = "owner_ref IS NOT NULL AND due_source IN ('explicit','relative','weekday')";
const hasHumanTerm = (row: Raw): boolean => row.owner_ref !== null && (row.due_source === "explicit" || row.due_source === "relative" || row.due_source === "weekday");

const fromRaw = (row: Raw): Deferral => {
  const termless = row.state !== "closed" && !hasHumanTerm(row);
  return {
    id: row.id, projectId: row.project_id, what: row.what, kind: row.kind, area: row.area, dueAt: termless ? null : row.due_at, dueSource: termless ? null : row.due_source,
    ownerRef: json<OwnerRef | null>(row.owner_ref, null), ownerQuote: row.owner_quote, state: termless ? "needs_owner_term" : row.state, history: json(row.history_json, []),
    source: row.source, createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at, closedBy: row.closed_by,
  };
};

/** A runtime id; seeded entries have fixed ids (`dfr_seed_…`, seed.ts). */
export const newDeferralId = (): string => `dfr_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

export function getDeferral(db: DeferralDb, id: string): Deferral | null {
  const row = db.prepare("SELECT * FROM lane_pilot_deferral WHERE id=?").get(id) as Raw | undefined;
  return row ? fromRaw(row) : null;
}

/** Open entries whose human term passed become `overdue` (stored, so a plain SQL read sees them too). An entry with no human term never does. */
export function sweepOverdue(db: DeferralDb, now: number): number {
  return db.prepare(`UPDATE lane_pilot_deferral SET state='overdue', updated_at=? WHERE state='open' AND due_at IS NOT NULL AND due_at<? AND ${HUMAN_TERM_SQL}`).run(now, now).changes;
}

const STATE_RANK: Record<DeferralState, number> = { overdue: 0, open: 1, needs_owner_term: 2, closed: 3 };

export function listDeferrals(db: DeferralDb, filter: { projectId?: string | undefined; states?: readonly DeferralState[] | undefined } = {}): Deferral[] {
  const where: string[] = [], args: unknown[] = [];
  // A project sees its own entries and the global ones.
  if (filter.projectId) { where.push("(project_id=? OR project_id IS NULL)"); args.push(filter.projectId); }
  const sql = `SELECT * FROM lane_pilot_deferral${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  // The state is read after the term rule (fromRaw), so the filter and the order are applied here, not in SQL.
  return (db.prepare(sql).all(...args) as Raw[]).map(fromRaw).filter((row) => !filter.states?.length || filter.states.includes(row.state))
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt);
}

/**
 * The open entries with no term from a human that count as unproven in a phase of this project: the project's own skipped checks and
 * gates. A global entry (no project, like the plugin's own seeds) and an entry of another project never block it, and a wall's backlog
 * item is its own line, not a deferral. Entries carry no run or task id, so the project is the narrowest scope there is.
 */
export function noTermDeferralsOf(db: DeferralDb, projectId: string): Array<{ id: string; what: string }> {
  if (!projectId) return [];
  return listDeferrals(db, { states: ["needs_owner_term"] }).filter((row) => row.projectId === projectId && (row.kind === "skipped_test" || row.kind === "gate")).map((row) => ({ id: row.id, what: row.what }));
}

export function insertDeferral(db: DeferralDb, row: Deferral, ignoreExisting = false): boolean {
  const result = db.prepare(`INSERT ${ignoreExisting ? "OR IGNORE " : ""}INTO lane_pilot_deferral
    (id,project_id,what,kind,area,due_at,due_source,owner_ref,owner_quote,state,history_json,source,created_at,updated_at,closed_at,closed_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.projectId, row.what, row.kind, row.area, row.dueAt, row.dueSource,
    row.ownerRef ? JSON.stringify(row.ownerRef) : null, row.ownerQuote, row.state, JSON.stringify(row.history), row.source, row.createdAt, row.updatedAt, row.closedAt, row.closedBy);
  return result.changes > 0;
}

/** Gives an entry a new term (first term or an extension). The previous term goes to the history. */
export function setTerm(db: DeferralDb, id: string, term: { dueAt: number; dueSource: DueSource; ownerRef: OwnerRef | null; ownerQuote: string }, now: number): void {
  const row = getDeferral(db, id)!;
  const history = row.dueAt !== null || row.ownerRef ? [...row.history, { dueAt: row.dueAt, dueSource: row.dueSource, ownerRef: row.ownerRef, at: now }] : row.history;
  db.prepare("UPDATE lane_pilot_deferral SET due_at=?, due_source=?, owner_ref=?, owner_quote=?, state=?, history_json=?, updated_at=? WHERE id=?")
    .run(term.dueAt, term.dueSource, JSON.stringify(term.ownerRef), term.ownerQuote, term.dueAt < now ? "overdue" : "open", JSON.stringify(history), now, id);
}

export function closeDeferral(db: DeferralDb, id: string, evidence: string, now: number): void {
  db.prepare("UPDATE lane_pilot_deferral SET state='closed', closed_at=?, closed_by=?, updated_at=? WHERE id=?").run(now, evidence, now, id);
}

export type Counts = Record<DeferralState, number>;
export function countDeferrals(rows: readonly Deferral[]): Counts {
  const counts: Counts = { open: 0, overdue: 0, closed: 0, needs_owner_term: 0 };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}
