import type Database from "better-sqlite3";
import { costUsd, priceFor } from "../model-prices";
import type { CostView } from "../schedule/views";
import { billedFrom, parseBreakdown } from "./token-usage";

/**
 * What a scheduled run cost, from the token usage Lane Pilot syncs per thread (`lane_pilot_token_cursor`, cumulative per thread).
 * A run that has no row (an ACP provider reports no usage, or the sync has not seen the thread yet) is «unknown», never zero; a model
 * without a price in `src/model-prices.ts` has tokens but no cost.
 */
export type ThreadUsage = { providerId: string | null; model: string | null; tokens: number | null; costUsd: number | null; usageKnown: boolean };
export const NO_USAGE: ThreadUsage = { providerId: null, model: null, tokens: null, costUsd: null, usageKnown: false };

type CursorRow = { total_json: string; last_model: string; last_provider: string; provider_id: string };

/** The usage a cursor row holds, priced with the model it last ran on. */
export function usageOfCursor(row: CursorRow | undefined): ThreadUsage {
  if (!row) return NO_USAGE;
  const billed = billedFrom(parseBreakdown(row.total_json));
  const providerId = row.last_provider || row.provider_id || null, model = row.last_model || null;
  if (billed.total <= 0 && billed.output <= 0) return { ...NO_USAGE, providerId, model };
  return { providerId, model, tokens: billed.total, costUsd: model ? costUsd(model, billed) : null, usageKnown: true };
}

export function threadUsage(db: Database.Database, threadId: string): ThreadUsage {
  try {
    return usageOfCursor(db.prepare("SELECT total_json, last_model, last_provider, provider_id FROM lane_pilot_token_cursor WHERE thread_id=?").get(threadId) as CursorRow | undefined);
  } catch { return NO_USAGE; }
}

/** The average over the costs that are known; `samples` counts them. */
export function averageCost(costs: ReadonlyArray<number | null>): { perRunUsd: number | null; samples: number } {
  const known = costs.filter((value): value is number => value !== null);
  return { perRunUsd: known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null, samples: known.length };
}

/** The price of a model per 1M tokens in and out; null when the price table does not have it. */
export function priceView(model: string | null): Pick<CostView, "priceInPer1M" | "priceOutPer1M"> {
  const price = model ? priceFor(model) : null;
  return { priceInPer1M: price?.input ?? null, priceOutPer1M: price?.output ?? null };
}

const COST_WINDOW = 20;

/** Cost per run of an errand schedule: the average over its last runs whose thread has known usage and a priced model, and the price of `model` now. */
export function scheduleCost(db: Database.Database, scheduleId: string, model: string | null): CostView {
  let costs: Array<number | null> = [];
  try {
    const rows = db.prepare(`SELECT c.total_json, c.last_model, c.last_provider, c.provider_id FROM lane_pilot_schedule_run r
      JOIN lane_pilot_token_cursor c ON c.thread_id=r.ref_id
      WHERE r.schedule_id=? AND r.ref_kind='thread' AND r.status IN ('succeeded','failed','timed_out') ORDER BY r.scheduled_at DESC LIMIT ?`).all(scheduleId, COST_WINDOW) as CursorRow[];
    costs = rows.map((row) => usageOfCursor(row).costUsd);
  } catch { costs = []; }
  return { ...averageCost(costs), ...priceView(model) };
}
