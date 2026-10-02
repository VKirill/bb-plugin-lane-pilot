import type Database from "better-sqlite3";

export type InsightsDatabase = Pick<Database.Database, "prepare">;

export type WriterStatRow = {
  providerId: string;
  model: string;
  risk: string;
  tasks: number;
  acceptedFirstTry: number;
  accepted: number;
  failed: number;
};

type ReceiptRow = {
  run_id: string;
  task_id: string;
  provider_id: string | null;
  model: string | null;
  acceptance_state: string | null;
  acceptance_attempt: number | null;
  contract_json: string;
};

function riskOf(contractJson: string): string {
  try {
    const risk = (JSON.parse(contractJson) as { risk?: unknown }).risk;
    return typeof risk === "string" && risk ? risk : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * One row per provider, model and task risk. A task counts once; it is accepted at the first try
 * when its acceptance receipt passed at the first attempt (attempt_no 1; 0 in older receipts), accepted when it passed at any attempt, and
 * failed when the receipt ended failed or blocked.
 */
export function writerAcceptanceStats(db: InsightsDatabase, filter: { projectId?: string; since?: number } = {}): WriterStatRow[] {
  const where = ["w.stage_id='writer-agent'", "w.provider_id IS NOT NULL", "w.model IS NOT NULL"];
  const params: unknown[] = [];
  if (filter.projectId) { where.push("r.project_id=?"); params.push(filter.projectId); }
  if (filter.since !== undefined) { where.push("w.updated_at>=?"); params.push(filter.since); }
  const rows = db.prepare(`SELECT w.run_id, w.task_id, w.provider_id, w.model, a.state AS acceptance_state, a.attempt AS acceptance_attempt, t.contract_json
    FROM lane_pilot_stage_receipt w
    JOIN lane_pilot_run r ON r.id=w.run_id
    JOIN lane_pilot_task t ON t.id=w.task_id
    LEFT JOIN lane_pilot_stage_receipt a ON a.run_id=w.run_id AND a.task_id=w.task_id AND a.stage_id='acceptance-receipt'
    WHERE ${where.join(" AND ")}`).all(...params) as ReceiptRow[];
  const byKey = new Map<string, WriterStatRow>();
  for (const row of rows) {
    const risk = riskOf(row.contract_json);
    const key = `${row.provider_id}\0${row.model}\0${risk}`;
    let stat = byKey.get(key);
    if (!stat) {
      stat = { providerId: row.provider_id!, model: row.model!, risk, tasks: 0, acceptedFirstTry: 0, accepted: 0, failed: 0 };
      byKey.set(key, stat);
    }
    stat.tasks += 1;
    if (row.acceptance_state === "passed") {
      stat.accepted += 1;
      if (row.acceptance_attempt !== null && row.acceptance_attempt <= 1) stat.acceptedFirstTry += 1;
    } else if (row.acceptance_state === "failed" || row.acceptance_state === "blocked") {
      stat.failed += 1;
    }
  }
  return [...byKey.values()].sort((a, b) => b.tasks - a.tasks || a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model) || a.risk.localeCompare(b.risk));
}

export type WriterRecommendation = { providerId: string; model: string; firstTryRate: number; tasks: number };

/** The pair with the best first-try rate for a risk, among pairs with at least `minTasks` tasks. */
export function recommendWriter(stats: readonly WriterStatRow[], input: { risk: string; minTasks?: number }): WriterRecommendation | null {
  const minTasks = input.minTasks ?? 5;
  let best: WriterRecommendation | null = null;
  for (const row of stats) {
    if (row.risk !== input.risk || row.tasks < minTasks) continue;
    const firstTryRate = row.acceptedFirstTry / row.tasks;
    if (!best || firstTryRate > best.firstTryRate || (firstTryRate === best.firstTryRate && row.tasks > best.tasks)) {
      best = { providerId: row.providerId, model: row.model, firstTryRate, tasks: row.tasks };
    }
  }
  return best;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** A sentence for the settings screen; empty when there is nothing to say yet. */
export function routingHint(stats: readonly WriterStatRow[], current: { providerId: string; model: string } | null, risk: string, minTasks = 5): string {
  const best = recommendWriter(stats, { risk, minTasks });
  if (!best) return "";
  const own = current ? stats.find((row) => row.risk === risk && row.providerId === current.providerId && row.model === current.model) : undefined;
  if (own && own.tasks >= minTasks) {
    const ownRate = own.acceptedFirstTry / own.tasks;
    if (own.providerId === best.providerId && own.model === best.model) {
      return `${current!.providerId}/${current!.model}: ${percent(ownRate)} of ${own.tasks} ${risk}-risk tasks accepted at the first try, the best pair on record.`;
    }
    return `${current!.providerId}/${current!.model}: ${percent(ownRate)} first-try on ${own.tasks} ${risk}-risk tasks; ${best.providerId}/${best.model} reached ${percent(best.firstTryRate)} on ${best.tasks}.`;
  }
  return `${best.providerId}/${best.model} has the best first-try acceptance for ${risk}-risk tasks: ${percent(best.firstTryRate)} of ${best.tasks}.`;
}
