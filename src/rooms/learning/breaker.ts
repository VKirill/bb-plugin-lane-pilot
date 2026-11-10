import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

/**
 * The rule loop breaker (SMA k_lib_breaker / k_v_breaker): a rule that fires at the same target (a task family)
 * three repair rounds in a row would trap the worker in a loop, so it is soft-disabled for that target — filtered out
 * of its judgments and remarks — until a person re-arms it after looking at it. Kept in `lane_pilot_kv` under
 * `rules:breaker`, one row per (project, rule hash, target): how many rounds in a row it fired, whether it is
 * tripped, who re-armed it and why.
 */
export type BreakerRow = { project: string; ruleHash: string; target: string; count: number; tripped: boolean; firstAt: number; lastAt: number; reason?: string; by?: string };
type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };

const KEY = "rules:breaker";
const TRIP_AT = 3;
const STALE_MS = 7 * 86_400_000;
export const ruleHash = (rule: string): string => createHash("sha256").update(rule.trim().toLowerCase()).digest("hex").slice(0, 16);
export const breakerRowId = (project: string, hash: string, target: string): string => `${project} ${hash} ${target}`;

async function readAll(kv: Kv): Promise<Record<string, BreakerRow>> {
  return ((await kv.get(KEY)) as Record<string, BreakerRow> | null) ?? {};
}
async function writeAll(kv: Kv, rows: Record<string, BreakerRow>): Promise<void> {
  await kv.set(KEY, rows as never);
}

/** One repair round on one target: counts the rules that fired, resets the rest, and trips a rule at three in a row. */
export async function noteBreakerRound(kv: Kv, input: { project: string; target: string; fired: readonly string[]; now?: number }): Promise<BreakerRow[]> {
  const rows = await readAll(kv);
  const now = input.now ?? Date.now();
  const fired = new Set(input.fired.map(ruleHash));
  const tripped: BreakerRow[] = [];
  // Only this target's rows move: a rule that fired counts up, one that stayed silent loses its row (a streak ended).
  const here = Object.values(rows).filter((row) => row.project === input.project && row.target === input.target).map((row) => row.ruleHash);
  for (const hash of new Set([...here, ...fired])) {
    const id = breakerRowId(input.project, hash, input.target);
    const row = rows[id] ?? { project: input.project, ruleHash: hash, target: input.target, count: 0, tripped: false, firstAt: now, lastAt: now };
    if (fired.has(hash)) {
      row.count += 1;
      row.lastAt = now;
      if (row.count >= TRIP_AT && !row.tripped) { row.tripped = true; tripped.push(row); }
      rows[id] = row;
    } else if (!row.tripped) {
      delete rows[id];
    }
  }
  // A streak nobody continued for a week belongs to a finished task: its row goes, a tripped one stays for the person.
  for (const [id, row] of Object.entries(rows)) if (!row.tripped && now - row.lastAt > STALE_MS) delete rows[id];
  await writeAll(kv, rows);
  return tripped;
}

/** The rule hashes soft-disabled for this target right now. */
export async function trippedRules(kv: Kv, project: string, target: string): Promise<Set<string>> {
  const rows = await readAll(kv);
  return new Set(Object.values(rows).filter((row) => row.tripped && row.project === project && row.target === target).map((row) => row.ruleHash));
}

/** Every tripped row (of one project, or all): what the `breaker` list shows. */
export async function listTripped(kv: Kv, project?: string): Promise<BreakerRow[]> {
  return Object.values(await readAll(kv)).filter((row) => row.tripped && (!project || row.project === project));
}

/** Re-arm a tripped row after a person looked at it: keeps who and why, and the rule fires at that target again. */
export async function rearmBreaker(kv: Kv, id: string, input: { why: string; by?: string; now?: number }): Promise<BreakerRow | null> {
  if (!input.why?.trim()) return null;
  const rows = await readAll(kv);
  const row = rows[id];
  if (!row || !row.tripped) return null;
  rows[id] = { ...row, tripped: false, count: 0, reason: input.why, by: input.by ?? "owner", lastAt: input.now ?? Date.now() };
  await writeAll(kv, rows);
  return rows[id]!;
}
