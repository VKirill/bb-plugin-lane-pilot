import type { EvolveCaseDb } from "./case-repository";

export type EvolveLoopHealthStats = {
  proposed4w: number;
  promoted4w: number;
  rollbacks30d: number;
  rollbackIds: string[];
};

const EVOLVE_DAY_MS = 86_400_000;

/** Aggregates 4-week hypothesis proposal/promotion counts and 30-day rollbacks for loop health evaluation. */
export function evolveLoopHealthStats(
  db: EvolveCaseDb,
  options: { now?: number; windowDays4w?: number; rollbackWindowDays?: number } = {},
): EvolveLoopHealthStats {
  const now = options.now ?? Date.now();
  const since4w = now - (options.windowDays4w ?? 28) * EVOLVE_DAY_MS;
  const since30d = now - (options.rollbackWindowDays ?? 30) * EVOLVE_DAY_MS;

  const hasHyp = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lane_pilot_evolve_hypothesis'").get(),
  );
  const hasTrial = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lane_pilot_evolve_trial'").get(),
  );

  let proposed4w = 0;
  const promotedIds = new Set<string>();
  const retiredPostPromoIds = new Set<string>();
  const rollbackIds = new Set<string>();

  if (hasHyp) {
    const propRow = db.prepare(
      `SELECT COUNT(*) AS cnt
       FROM lane_pilot_evolve_hypothesis
       WHERE created_at >= ?`,
    ).get(since4w) as { cnt?: unknown } | undefined;
    proposed4w = Number(propRow?.cnt ?? 0);

    const promoRows = db.prepare(
      `SELECT id
       FROM lane_pilot_evolve_hypothesis
       WHERE state = 'promoted' AND COALESCE(decided_at, created_at) >= ?`,
    ).all(since4w) as Array<{ id: string }>;
    for (const row of promoRows) promotedIds.add(row.id);

    const postPromoRollbacks = db.prepare(
      `SELECT id, COALESCE(decided_at, created_at) AS at
       FROM lane_pilot_evolve_hypothesis
       WHERE state = 'retired' AND reason = 'post_promotion_reject'`,
    ).all() as Array<{ id: string; at: number }>;
    for (const row of postPromoRollbacks) {
      retiredPostPromoIds.add(row.id);
      if (row.at >= since30d) rollbackIds.add(row.id);
    }
  }

  if (hasTrial) {
    const trialPromos = db.prepare(
      `SELECT hypothesis_id
       FROM lane_pilot_evolve_trial
       WHERE state = 'promoted' AND COALESCE(closed_at, opened_at) >= ?`,
    ).all(since4w) as Array<{ hypothesis_id: string }>;
    for (const row of trialPromos) {
      if (!retiredPostPromoIds.has(row.hypothesis_id)) {
        promotedIds.add(row.hypothesis_id);
      }
    }

    const trialRollbacks = db.prepare(
      `SELECT trial_id, hypothesis_id
       FROM lane_pilot_evolve_trial
       WHERE state = 'rolled_back' AND COALESCE(closed_at, opened_at) >= ?`,
    ).all(since30d) as Array<{ trial_id: string; hypothesis_id: string }>;
    for (const row of trialRollbacks) {
      rollbackIds.add(row.hypothesis_id || row.trial_id);
    }
  }

  return {
    proposed4w,
    promoted4w: promotedIds.size,
    rollbacks30d: rollbackIds.size,
    rollbackIds: [...rollbackIds].sort(),
  };
}
