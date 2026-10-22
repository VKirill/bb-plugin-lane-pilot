import { randomUUID } from "node:crypto";
import type { WallDb } from "./journal";
import { OPEN_REPAIR_STATES, type HuntState, type NightSummary, type RepairState } from "./types";

const json = <T>(text: string | null | undefined, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };

// ---- repairs (one round of one class)
export type RepairRow = {
  id: string; classKey: string; night: string; round: number; role: "engineer" | "informed"; state: RepairState; signature: string; threadId: string | null;
  brief: Record<string, unknown>; versionBefore: string; shippedVersion: string | null; mergedCommit: string | null; branch: string | null;
  tokensEst: number; tokensUsed: number | null; verdict: string | null; policy: Record<string, unknown> | null; acceptance: Record<string, unknown> | null;
  outcome: string | null; createdAt: number; updatedAt: number;
};
type RepairRaw = {
  id: string; class_key: string; night: string; round: number; role: "engineer" | "informed"; state: RepairState; signature: string; thread_id: string | null; brief_json: string;
  version_before: string; shipped_version: string | null; merged_commit: string | null; branch: string | null; tokens_est: number; tokens_used: number | null; verdict: string | null;
  policy_json: string | null; acceptance_json: string | null; outcome: string | null; created_at: number; updated_at: number;
};
const repairFrom = (r: RepairRaw): RepairRow => ({
  id: r.id, classKey: r.class_key, night: r.night, round: r.round, role: r.role, state: r.state, signature: r.signature, threadId: r.thread_id, brief: json(r.brief_json, {}),
  versionBefore: r.version_before, shippedVersion: r.shipped_version, mergedCommit: r.merged_commit, branch: r.branch, tokensEst: r.tokens_est, tokensUsed: r.tokens_used,
  verdict: r.verdict, policy: json(r.policy_json, null), acceptance: json(r.acceptance_json, null), outcome: r.outcome, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function insertRepair(db: WallDb, input: { classKey: string; signature: string; night: string; round: number; role: "engineer" | "informed"; brief: Record<string, unknown>; versionBefore: string; tokensEst: number; now: number }): RepairRow {
  const id = `wr_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  db.prepare(`INSERT INTO lane_pilot_wall_repair (id,class_key,night,round,role,state,signature,brief_json,version_before,tokens_est,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?)`)
    .run(id, input.classKey, input.night, input.round, input.role, input.signature, JSON.stringify(input.brief), input.versionBefore, input.tokensEst, input.now, input.now);
  return getRepair(db, id)!;
}
export function getRepair(db: WallDb, id: string): RepairRow | null {
  const row = db.prepare("SELECT * FROM lane_pilot_wall_repair WHERE id=?").get(id) as RepairRaw | undefined;
  return row ? repairFrom(row) : null;
}
export function listRepairs(db: WallDb, filter: { states?: readonly RepairState[]; classKey?: string; since?: number } = {}): RepairRow[] {
  const where: string[] = [], args: unknown[] = [];
  if (filter.states?.length) { where.push(`state IN (${filter.states.map(() => "?").join(",")})`); args.push(...filter.states); }
  if (filter.classKey) { where.push("class_key=?"); args.push(filter.classKey); }
  if (filter.since !== undefined) { where.push("created_at>=?"); args.push(filter.since); }
  return (db.prepare(`SELECT * FROM lane_pilot_wall_repair ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`).all(...args) as RepairRaw[]).map(repairFrom);
}
export const openRepairs = (db: WallDb): RepairRow[] => listRepairs(db, { states: OPEN_REPAIR_STATES });

const REPAIR_COLUMNS: Record<string, string> = {
  state: "state", threadId: "thread_id", shippedVersion: "shipped_version", mergedCommit: "merged_commit", branch: "branch", tokensUsed: "tokens_used", verdict: "verdict", outcome: "outcome",
};
export function updateRepair(db: WallDb, id: string, patch: Partial<Pick<RepairRow, "state" | "threadId" | "shippedVersion" | "mergedCommit" | "branch" | "tokensUsed" | "verdict" | "outcome">> & { policy?: unknown; acceptance?: unknown }, now: number): void {
  const sets: string[] = ["updated_at=?"], args: unknown[] = [now];
  for (const [key, column] of Object.entries(REPAIR_COLUMNS)) if ((patch as Record<string, unknown>)[key] !== undefined) { sets.push(`${column}=?`); args.push((patch as Record<string, unknown>)[key]); }
  if (patch.policy !== undefined) { sets.push("policy_json=?"); args.push(JSON.stringify(patch.policy)); }
  if (patch.acceptance !== undefined) { sets.push("acceptance_json=?"); args.push(JSON.stringify(patch.acceptance)); }
  db.prepare(`UPDATE lane_pilot_wall_repair SET ${sets.join(",")} WHERE id=?`).run(...args, id);
}

// ---- nights
export function saveNight(db: WallDb, summary: NightSummary, now: number, finished = true): void {
  db.prepare(`INSERT INTO lane_pilot_wall_night (night,started_at,finished_at,dry_run,summary_json,spend_tokens,cap_tokens) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(night) DO UPDATE SET finished_at=excluded.finished_at, dry_run=excluded.dry_run, summary_json=excluded.summary_json, spend_tokens=excluded.spend_tokens, cap_tokens=excluded.cap_tokens`)
    .run(summary.night, summary.startedAt, finished ? now : null, summary.dryRun ? 1 : 0, JSON.stringify(summary), summary.spendTokens, summary.capTokens);
}
export function getNight(db: WallDb, night: string): (NightSummary & { finishedAt: number | null }) | null {
  const row = db.prepare("SELECT summary_json, finished_at FROM lane_pilot_wall_night WHERE night=?").get(night) as { summary_json: string; finished_at: number | null } | undefined;
  return row ? { ...json<NightSummary>(row.summary_json, {} as NightSummary), finishedAt: row.finished_at } : null;
}
export function recentNights(db: WallDb, limit = 14): Array<{ night: string; spend: number; cap: number; dryRun: boolean; startedAt: number }> {
  return (db.prepare("SELECT night, spend_tokens, cap_tokens, dry_run, started_at FROM lane_pilot_wall_night ORDER BY night DESC LIMIT ?").all(limit) as Array<{ night: string; spend_tokens: number; cap_tokens: number; dry_run: number; started_at: number }>)
    .map((row) => ({ night: row.night, spend: row.spend_tokens, cap: row.cap_tokens, dryRun: row.dry_run === 1, startedAt: row.started_at }));
}
/** What the night has spent so far: its repair rounds (real usage once synced, the estimate before) plus the hunts and analyses that ran inside [from, to). */
export function nightSpend(db: WallDb, night: string, range: { from: number; to: number }): number {
  return (db.prepare("SELECT COALESCE(SUM(COALESCE(tokens_used, tokens_est)),0) AS n FROM lane_pilot_wall_repair WHERE night=?").get(night) as { n: number }).n
    + (db.prepare("SELECT COALESCE(SUM(tokens_used),0) AS n FROM lane_pilot_wall WHERE updated_at>=? AND updated_at<?").get(range.from, range.to) as { n: number }).n;
}

/** Keeps the night row's spend current when hunts and analyses run after the night job (the task walls' hunts in `advance`). */
export function refreshNightSpend(db: WallDb, night: string, range: { from: number; to: number }): void {
  const spend = nightSpend(db, night, range);
  db.prepare("UPDATE lane_pilot_wall_night SET spend_tokens=? WHERE night=? AND spend_tokens<>?").run(spend, night, spend);
}

// ---- walls (the ladder of a class or a task family)
export type WallRow = {
  key: string; kind: "class" | "task"; subject: string; projectId: string; state: "stopped" | "hunting" | "hunted" | "backlog" | "closed"; moves: number; hunt: HuntState;
  pack: unknown; findings: unknown; messageSentAt: number | null; deferralId: string | null; analysis: unknown; tokensUsed: number; createdAt: number; updatedAt: number; closedAt: number | null; closedBy: string | null;
};
type WallRaw = { wall_key: string; kind: "class" | "task"; subject: string; project_id: string; state: WallRow["state"]; moves: number; hunt_state: HuntState; pack_json: string | null; findings_json: string | null;
  message_sent_at: number | null; deferral_id: string | null; analysis_json: string | null; tokens_used: number; created_at: number; updated_at: number; closed_at: number | null; closed_by: string | null };
const wallFrom = (r: WallRaw): WallRow => ({ key: r.wall_key, kind: r.kind, subject: r.subject, projectId: r.project_id, state: r.state, moves: r.moves, hunt: r.hunt_state, pack: json(r.pack_json, null),
  findings: json(r.findings_json, null), messageSentAt: r.message_sent_at, deferralId: r.deferral_id, analysis: json(r.analysis_json, null), tokensUsed: r.tokens_used, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at, closedBy: r.closed_by });

export function getWall(db: WallDb, key: string): WallRow | null {
  const row = db.prepare("SELECT * FROM lane_pilot_wall WHERE wall_key=?").get(key) as WallRaw | undefined;
  return row ? wallFrom(row) : null;
}
export function listWalls(db: WallDb, filter: { states?: readonly WallRow["state"][]; kind?: "class" | "task" } = {}): WallRow[] {
  const where: string[] = [], args: unknown[] = [];
  if (filter.states?.length) { where.push(`state IN (${filter.states.map(() => "?").join(",")})`); args.push(...filter.states); }
  if (filter.kind) { where.push("kind=?"); args.push(filter.kind); }
  return (db.prepare(`SELECT * FROM lane_pilot_wall ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`).all(...args) as WallRaw[]).map(wallFrom);
}
export function insertWall(db: WallDb, row: { key: string; kind: "class" | "task"; subject: string; projectId: string; state: WallRow["state"]; moves: number; now: number }): void {
  db.prepare(`INSERT OR IGNORE INTO lane_pilot_wall (wall_key,kind,subject,project_id,state,moves,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(row.key, row.kind, row.subject, row.projectId, row.state, row.moves, row.now, row.now);
}
export function updateWall(db: WallDb, key: string, patch: Partial<Pick<WallRow, "state" | "moves" | "hunt" | "messageSentAt" | "deferralId" | "tokensUsed" | "closedAt" | "closedBy">> & { pack?: unknown; findings?: unknown; analysis?: unknown }, now: number): void {
  const map: Record<string, string> = { state: "state", moves: "moves", hunt: "hunt_state", messageSentAt: "message_sent_at", deferralId: "deferral_id", tokensUsed: "tokens_used", closedAt: "closed_at", closedBy: "closed_by" };
  const sets: string[] = ["updated_at=?"], args: unknown[] = [now];
  for (const [field, column] of Object.entries(map)) if ((patch as Record<string, unknown>)[field] !== undefined) { sets.push(`${column}=?`); args.push((patch as Record<string, unknown>)[field]); }
  for (const [field, column] of [["pack", "pack_json"], ["findings", "findings_json"], ["analysis", "analysis_json"]] as const) if (patch[field] !== undefined) { sets.push(`${column}=?`); args.push(JSON.stringify(patch[field])); }
  db.prepare(`UPDATE lane_pilot_wall SET ${sets.join(",")} WHERE wall_key=?`).run(...args, key);
}

// ---- the ladder columns of a class
export function updateClassLadder(db: WallDb, classKey: string, patch: { failedMoves?: number; hunt?: HuntState; afterHuntFailed?: number; stage?: string; fixedIn?: string | null }, now: number): void {
  const sets: string[] = ["updated_at=?"], args: unknown[] = [now];
  if (patch.failedMoves !== undefined) { sets.push("failed_moves=?"); args.push(patch.failedMoves); }
  if (patch.hunt !== undefined) { sets.push("hunt_state=?"); args.push(patch.hunt); }
  if (patch.afterHuntFailed !== undefined) { sets.push("after_hunt_failed=?"); args.push(patch.afterHuntFailed); }
  if (patch.stage !== undefined) { sets.push("stage=?"); args.push(patch.stage); }
  if (patch.fixedIn !== undefined) { sets.push("fixed_in=?"); args.push(patch.fixedIn); }
  db.prepare(`UPDATE lane_pilot_wall_class SET ${sets.join(",")} WHERE class_key=?`).run(...args, classKey);
}
