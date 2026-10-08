import type Database from "better-sqlite3";
import type { Route } from "./judgment";
import { sha256Hex } from "@lane-pilot/kit";

export type Db = Pick<Database.Database, "prepare">;
export const DAY_MS = 86_400_000;
export const startOfDay = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS;

export type ObsState = "skipped" | "observed" | "candidate" | "extracted" | "ignored";
export type Observation = {
  id: string; threadId: string; projectId: string; at: number; judgedAt: number; source: "live" | "catchup"; chars: number;
  excerpt: string | null; state: ObsState; skipReason: string | null; sensitive: boolean;
  jevStatus: string | null; receiptId: number | null;
  kind: string | null; kindP: number | null; learnP: number | null; durable: number | null; scope: string | null; frustration: number | null; deadline: number | null; route: Route | null;
  secondStatus: string | null; secondKind: string | null; secondLearnP: number | null; secondDurable: number | null; secondRoute: Route | null; secondMs: number | null; secondTokens: number | null;
  finalRoute: "none" | "learn" | null; body: string | null; prev: string | null; review: string | null; reviewedAt: number | null;
};

type Row = Record<string, unknown>;
const COLUMNS = ["id", "thread_id", "project_id", "at", "judged_at", "source", "chars", "excerpt", "state", "skip_reason", "sensitive", "jev_status", "receipt_id",
  "kind", "kind_p", "learn_p", "durable", "scope", "frustration", "deadline", "route", "second_status", "second_kind", "second_learn_p", "second_durable", "second_route",
  "second_ms", "second_tokens", "final_route", "body", "prev", "review", "reviewed_at"] as const;

const fromRow = (row: Row): Observation => ({
  id: row.id as string, threadId: row.thread_id as string, projectId: row.project_id as string, at: row.at as number, judgedAt: row.judged_at as number,
  source: row.source as "live" | "catchup", chars: row.chars as number, excerpt: (row.excerpt as string | null) ?? null, state: row.state as ObsState,
  skipReason: (row.skip_reason as string | null) ?? null, sensitive: row.sensitive === 1, jevStatus: (row.jev_status as string | null) ?? null, receiptId: (row.receipt_id as number | null) ?? null,
  kind: (row.kind as string | null) ?? null, kindP: (row.kind_p as number | null) ?? null, learnP: (row.learn_p as number | null) ?? null, durable: (row.durable as number | null) ?? null,
  scope: (row.scope as string | null) ?? null, frustration: (row.frustration as number | null) ?? null, deadline: (row.deadline as number | null) ?? null, route: (row.route as Route | null) ?? null,
  secondStatus: (row.second_status as string | null) ?? null, secondKind: (row.second_kind as string | null) ?? null, secondLearnP: (row.second_learn_p as number | null) ?? null,
  secondDurable: (row.second_durable as number | null) ?? null, secondRoute: (row.second_route as Route | null) ?? null, secondMs: (row.second_ms as number | null) ?? null,
  secondTokens: (row.second_tokens as number | null) ?? null, finalRoute: (row.final_route as "none" | "learn" | null) ?? null, body: (row.body as string | null) ?? null,
  prev: (row.prev as string | null) ?? null, review: (row.review as string | null) ?? null, reviewedAt: (row.reviewed_at as number | null) ?? null,
});

/** Stores one observation; false when the message was already seen (a message reaches the hook more than once). */
export function insertObservation(db: Db, o: Observation): boolean {
  const values: Record<string, unknown> = {
    id: o.id, thread_id: o.threadId, project_id: o.projectId, at: o.at, judged_at: o.judgedAt, source: o.source, chars: o.chars, excerpt: o.excerpt, state: o.state,
    skip_reason: o.skipReason, sensitive: o.sensitive ? 1 : 0, jev_status: o.jevStatus, receipt_id: o.receiptId, kind: o.kind, kind_p: o.kindP, learn_p: o.learnP,
    durable: o.durable, scope: o.scope, frustration: o.frustration, deadline: o.deadline, route: o.route, second_status: o.secondStatus, second_kind: o.secondKind,
    second_learn_p: o.secondLearnP, second_durable: o.secondDurable, second_route: o.secondRoute, second_ms: o.secondMs, second_tokens: o.secondTokens,
    final_route: o.finalRoute, body: o.body, prev: o.prev, review: o.review, reviewed_at: o.reviewedAt,
  };
  return db.prepare(`INSERT OR IGNORE INTO lane_pilot_learning_obs (${COLUMNS.join(",")}) VALUES (${COLUMNS.map((c) => `@${c}`).join(",")})`).run(values).changes === 1;
}

export const hasObservation = (db: Db, id: string): boolean => Boolean(db.prepare("SELECT 1 FROM lane_pilot_learning_obs WHERE id=?").get(id));
export const getObservation = (db: Db, id: string): Observation | null => {
  const row = db.prepare("SELECT * FROM lane_pilot_learning_obs WHERE id=?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
};

/** How many messages Jev was asked about today, and how many second opinions were asked for (UTC day). */
export function usageToday(db: Db, now: number): { judged: number; second: number } {
  const since = startOfDay(now);
  const row = db.prepare(`SELECT sum(CASE WHEN jev_status='ok' THEN 1 ELSE 0 END) AS judged, sum(CASE WHEN second_status IS NOT NULL AND second_status<>'disabled' THEN 1 ELSE 0 END) AS second
    FROM lane_pilot_learning_obs WHERE judged_at>=?`).get(since) as { judged: number | null; second: number | null };
  return { judged: row.judged ?? 0, second: row.second ?? 0 };
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

/** Texts that waited a day without being read are dropped; the observation (its judgments) stays. */
export function purgeStaleBodies(db: Db, now: number, keepMs = DAY_MS): number {
  return db.prepare("UPDATE lane_pilot_learning_obs SET body=NULL, prev=NULL, state=CASE WHEN state='candidate' THEN 'ignored' ELSE state END, skip_reason=CASE WHEN state='candidate' THEN 'unread' ELSE skip_reason END WHERE (body IS NOT NULL OR prev IS NOT NULL) AND judged_at<?").run(now - keepMs).changes;
}

/* ---- the review of judgments (T1 acceptance) ---- */

export function reviewSample(db: Db, limit: number): Observation[] {
  return (db.prepare("SELECT * FROM lane_pilot_learning_obs WHERE review IS NULL AND excerpt IS NOT NULL AND jev_status='ok' AND state<>'skipped' ORDER BY RANDOM() LIMIT ?").all(limit) as Row[]).map(fromRow);
}

export function labelObservation(db: Db, id: string, correct: boolean, now: number): boolean {
  return db.prepare("UPDATE lane_pilot_learning_obs SET review=?, reviewed_at=? WHERE id=?").run(correct ? "ok" : "wrong", now, id).changes === 1;
}

export type ReviewStats = { reviewed: number; correct: number; accuracy: number | null };
export function reviewStats(db: Db): ReviewStats {
  const row = db.prepare("SELECT count(*) AS reviewed, sum(CASE WHEN review='ok' THEN 1 ELSE 0 END) AS correct FROM lane_pilot_learning_obs WHERE review IS NOT NULL").get() as { reviewed: number; correct: number | null };
  const correct = row.correct ?? 0;
  return { reviewed: row.reviewed, correct, accuracy: row.reviewed ? Math.round((correct / row.reviewed) * 1000) / 1000 : null };
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

/* ---- agreement of the two judges (T2) ---- */

export type AgreementReport = {
  since: number; judged: number; jevAnswered: number; withSecond: number; secondAnswered: number;
  /** Over messages both judges answered. */
  bothAnswered: number; sameRoute: number; routeAgreement: number | null; sameKind: number; kindAgreement: number | null;
  contested: number; contestedResolvedLearn: number; contestedResolvedNone: number;
  /** Jev none, second learn and the other way: the cases the extractor reads. */
  disagreements: number; jevOnly: number; secondOnly: number;
  secondTokens: number; secondUsd: number; secondP50Ms: number | null; secondP90Ms: number | null; secondFailures: number;
};

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};

export function agreementReport(db: Db, since: number, usdPerMillion: number): AgreementReport {
  const rows = db.prepare("SELECT route, kind, jev_status, second_status, second_route, second_kind, second_ms, second_tokens, final_route FROM lane_pilot_learning_obs WHERE judged_at>=? AND state<>'skipped'").all(since) as Array<{
    route: string | null; kind: string | null; jev_status: string | null; second_status: string | null; second_route: string | null; second_kind: string | null; second_ms: number | null; second_tokens: number | null; final_route: string | null }>;
  const report: AgreementReport = { since, judged: rows.length, jevAnswered: 0, withSecond: 0, secondAnswered: 0, bothAnswered: 0, sameRoute: 0, routeAgreement: null, sameKind: 0, kindAgreement: null,
    contested: 0, contestedResolvedLearn: 0, contestedResolvedNone: 0, disagreements: 0, jevOnly: 0, secondOnly: 0, secondTokens: 0, secondUsd: 0, secondP50Ms: null, secondP90Ms: null, secondFailures: 0 };
  const latencies: number[] = [];
  for (const row of rows) {
    const jev = row.jev_status === "ok" && row.route !== null, second = row.second_status === "ok" && row.second_route !== null;
    if (jev) report.jevAnswered += 1;
    if (row.second_status !== null && row.second_status !== "disabled") report.withSecond += 1;
    if (row.second_status !== null && row.second_status !== "ok" && row.second_status !== "disabled") report.secondFailures += 1;
    if (second) { report.secondAnswered += 1; report.secondTokens += row.second_tokens ?? 0; if (row.second_ms !== null) latencies.push(row.second_ms); }
    if (jev && second) {
      report.bothAnswered += 1;
      if (row.route === row.second_route) report.sameRoute += 1;
      if (row.kind === row.second_kind) report.sameKind += 1;
      if ((row.route === "learn" && row.second_route === "none") || (row.route === "none" && row.second_route === "learn")) report.disagreements += 1;
    }
    if (jev && row.route === "contested") {
      report.contested += 1;
      if (row.final_route === "learn") report.contestedResolvedLearn += 1; else if (row.final_route === "none") report.contestedResolvedNone += 1;
    }
    if (!jev && second) report.secondOnly += 1;
    if (jev && !second && row.second_status !== null && row.second_status !== "disabled") report.jevOnly += 1;
  }
  report.routeAgreement = report.bothAnswered ? Math.round((report.sameRoute / report.bothAnswered) * 1000) / 1000 : null;
  report.kindAgreement = report.bothAnswered ? Math.round((report.sameKind / report.bothAnswered) * 1000) / 1000 : null;
  report.secondUsd = Math.round((report.secondTokens / 1_000_000) * usdPerMillion * 10_000) / 10_000;
  report.secondP50Ms = percentile(latencies, 0.5);
  report.secondP90Ms = percentile(latencies, 0.9);
  return report;
}

/* ---- other signals (T8) ---- */

export type Signal = { id: number; kind: string; projectId: string | null; ref: string; p: number | null; detail: string | null; state: string; at: number };

export function insertSignal(db: Db, signal: { kind: string; projectId?: string | null; ref: string; p?: number | null; detail?: string | null; at: number }): boolean {
  return db.prepare("INSERT OR IGNORE INTO lane_pilot_learning_signal (kind,project_id,ref,p,detail,at) VALUES (?,?,?,?,?,?)")
    .run(signal.kind, signal.projectId ?? null, signal.ref, signal.p ?? null, signal.detail ?? null, signal.at).changes === 1;
}

export function listSignals(db: Db, filter: { kind?: string; since?: number; limit?: number } = {}): Signal[] {
  const where: string[] = [], args: unknown[] = [];
  if (filter.kind) { where.push("kind=?"); args.push(filter.kind); }
  if (filter.since !== undefined) { where.push("at>=?"); args.push(filter.since); }
  return (db.prepare(`SELECT id,kind,project_id AS projectId,ref,p,detail,state,at FROM lane_pilot_learning_signal ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ?`).all(...args, Math.min(filter.limit ?? 50, 500)) as Signal[]);
}

export function signalCounts(db: Db, since: number): Array<{ kind: string; n: number }> {
  return db.prepare("SELECT kind, count(*) AS n FROM lane_pilot_learning_signal WHERE at>=? GROUP BY kind ORDER BY kind").all(since) as Array<{ kind: string; n: number }>;
}
