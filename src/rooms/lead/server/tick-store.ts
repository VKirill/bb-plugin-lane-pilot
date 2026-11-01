import { randomUUID } from "node:crypto";
import type { Db } from "./journal";

/**
 * The receipts of the lead's ticks (roadmap §2.3, WP3): one row per tick, opened by the service before the graph starts (so a tick that
 * never ran still has a row saying so), closed by the graph's last step. The morning list shows a tick without a receipt; the panel shows
 * the last ten; the daily budget is the sum of today's `cost_micro_usd`.
 */
export type TickStatus = "running" | "ok" | "no_receipt" | "budget" | "error" | "off";
export type TickRow = {
  id: string; started_at: number; ended_at: number | null; wf_run_id: string | null; trigger: string;
  state_json: string | null; candidates_json: string | null; proposed_json: string | null; acted_json: string | null; deferred_json: string | null;
  tokens: number | null; cost_micro_usd: number | null; identity_sha: string | null; status: TickStatus;
};

export function openTick(db: Db, trigger: string, now: number = Date.now(), id: string = `tick_${randomUUID().slice(0, 8)}`): TickRow {
  db.prepare("INSERT INTO lane_pilot_lead_tick(id, started_at, trigger, status) VALUES (?,?,?,'running')").run(id, now, trigger);
  return getTick(db, id)!;
}

export const getTick = (db: Db, id: string): TickRow | undefined => db.prepare("SELECT * FROM lane_pilot_lead_tick WHERE id=?").get(id) as TickRow | undefined;

export function patchTick(db: Db, id: string, patch: Partial<Pick<TickRow, "wf_run_id" | "state_json" | "candidates_json" | "proposed_json" | "acted_json" | "deferred_json" | "tokens" | "cost_micro_usd" | "identity_sha">>): void {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (!keys.length) return;
  db.prepare(`UPDATE lane_pilot_lead_tick SET ${keys.map((key) => `${key}=?`).join(", ")} WHERE id=?`).run(...keys.map((key) => patch[key] ?? null), id);
}

export function closeTick(db: Db, id: string, status: Exclude<TickStatus, "running">, now: number = Date.now()): boolean {
  return db.prepare("UPDATE lane_pilot_lead_tick SET status=?, ended_at=? WHERE id=? AND status='running'").run(status, now, id).changes > 0;
}

export const listTicks = (db: Db, limit = 10): TickRow[] => db.prepare("SELECT * FROM lane_pilot_lead_tick ORDER BY started_at DESC LIMIT ?").all(limit) as TickRow[];

/** Micro-dollars spent by the ticks that started since `sinceMs` (today's budget), running ticks included. */
export function spentSince(db: Db, sinceMs: number): { costMicroUsd: number; ticks: number } {
  const row = db.prepare("SELECT COALESCE(SUM(cost_micro_usd),0) AS cost, COUNT(*) AS n FROM lane_pilot_lead_tick WHERE started_at>=?").get(sinceMs) as { cost: number; n: number };
  return { costMicroUsd: row.cost, ticks: row.n };
}

/** A running tick older than the limit never wrote its receipt: it is closed as `no_receipt` so the morning list can say so. Returns the ids closed. */
export function sweepStaleTicks(db: Db, olderThanMs: number, now: number = Date.now()): string[] {
  const stale = db.prepare("SELECT id FROM lane_pilot_lead_tick WHERE status='running' AND started_at<?").all(now - olderThanMs) as Array<{ id: string }>;
  for (const row of stale) closeTick(db, row.id, "no_receipt", now);
  return stale.map((row) => row.id);
}

/** The start of the current day in a time zone, ms since the epoch (the daily budget resets there). */
export function dayStart(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const sinceMidnight = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  return now - sinceMidnight - (now % 1000);
}
