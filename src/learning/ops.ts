import { loadConfig, parseConfigWords, saveConfig, type LearningConfig } from "./config";
import { DECISIONS_USD_PER_MILLION_INPUT } from "./opinion";
import { OWNER_MESSAGE_JUDGMENT_ID } from "./judgment";
import { DAY_MS, agreementReport, labelObservation, listItems, listSignals, reviewSample, reviewStats, signalCounts, startOfDay, usageToday, type Db, type Item, type ItemKind, type ItemState } from "./store";

/**
 * What the owner (or the PM, asked by the owner) reads and changes: the status of the learning with the evidence for switching it on,
 * the review of judgments, the agreement report, the learned items, the settings. One set of functions behind the PM's tool action
 * `lane_pilot_memory {action:"learned"}` and the CLI `bb lane-pilot learning …`; neither adds a rule of its own.
 */
export type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };

export const OBSERVE_DAYS = 7;
export const REVIEW_CASES = 50;
export const REVIEW_ACCURACY = 0.8;

export type OpsDeps = {
  db: Db; kv: Kv; now?(): number;
  /** Per project, how full the memory shelves are (housekeeping.ts). */
  memoryFill?(): unknown;
  /** Applies a changed config (rule budgets). */
  onConfig?(config: LearningConfig): void;
};

export function createOps(deps: OpsDeps) {
  const now = deps.now ?? Date.now;

  function jevCost(since: number) {
    const row = deps.db.prepare(`SELECT count(*) AS n, sum(tokens_in) AS tin, avg(latency_ms) AS ms FROM lane_pilot_jev_receipt WHERE judgment=? AND at>=?`).get(OWNER_MESSAGE_JUDGMENT_ID, since) as { n: number; tin: number | null; ms: number | null };
    return { requests: row.n, tokensIn: row.tin ?? 0, avgLatencyMs: row.ms === null ? null : Math.round(row.ms) };
  }

  async function status() {
    const config = await loadConfig(deps.kv), at = now(), week = at - 7 * DAY_MS;
    const first = (deps.db.prepare("SELECT min(judged_at) AS at FROM lane_pilot_learning_obs WHERE state<>'skipped'").get() as { at: number | null }).at;
    const byState = Object.fromEntries((deps.db.prepare("SELECT state, count(*) AS n FROM lane_pilot_learning_obs GROUP BY state").all() as Array<{ state: string; n: number }>).map((row) => [row.state, row.n]));
    const routes = Object.fromEntries((deps.db.prepare("SELECT final_route AS route, count(*) AS n FROM lane_pilot_learning_obs WHERE judged_at>=? AND final_route IS NOT NULL GROUP BY final_route").all(week) as Array<{ route: string; n: number }>).map((row) => [row.route, row.n]));
    const items = Object.fromEntries((deps.db.prepare("SELECT state, count(*) AS n FROM lane_pilot_learning_item GROUP BY state").all() as Array<{ state: string; n: number }>).map((row) => [row.state, row.n]));
    const review = reviewStats(deps.db), agreement = agreementReport(deps.db, week, DECISIONS_USD_PER_MILLION_INPUT);
    const days = first === null ? 0 : Math.floor((at - first) / DAY_MS);
    const missing = [
      ...(days < OBSERVE_DAYS ? [`${OBSERVE_DAYS - days} more day(s) of observation`] : []),
      ...(review.reviewed < REVIEW_CASES ? [`${REVIEW_CASES - review.reviewed} more reviewed case(s) (op:"review")`] : []),
      ...(review.accuracy !== null && review.reviewed >= REVIEW_CASES && review.accuracy < REVIEW_ACCURACY ? [`review accuracy ${review.accuracy} is under ${REVIEW_ACCURACY}`] : []),
    ];
    const usage = usageToday(deps.db, at);
    return {
      mode: config.mode, enabled: config.enabled,
      readyForActive: missing.length === 0, missing,
      observedDays: days, observations: byState, learnRoutesLast7Days: routes,
      today: { judged: usage.judged, judgeCap: config.dailyJudgeCap, secondOpinions: usage.second, secondOpinionCap: config.secondOpinionDailyCap, since: startOfDay(at) },
      review, agreementLast7Days: agreement,
      cost: { jevLast7Days: jevCost(week), secondOpinionUsdLast7Days: agreement.secondUsd },
      items, waitingForOwner: listItems(deps.db, { states: ["pending_owner"], limit: 100 }).length,
      signals: signalCounts(deps.db, week),
      ...(deps.memoryFill ? { memory: deps.memoryFill() } : {}),
    };
  }

  /** Cases to check by hand: what the judges said about a random message, to be marked right or wrong. */
  function review(limit = 10) {
    return reviewSample(deps.db, Math.min(Math.max(limit, 1), 50)).map((row) => ({
      id: row.id, text: row.excerpt, jev: { kind: row.kind, learnP: row.learnP, durable: row.durable, route: row.route },
      secondOpinion: row.secondRoute ? { kind: row.secondKind, route: row.secondRoute } : null, decided: row.finalRoute,
      question: "Is the decision (learn from this message or not) right?",
    }));
  }

  function label(id: string, correct: boolean) {
    if (!labelObservation(deps.db, id, correct, now())) throw new Error(`observation ${id} not found`);
    return reviewStats(deps.db);
  }

  async function configure(words: readonly string[]) {
    if (!words.length) return await loadConfig(deps.kv);
    const next = await saveConfig(deps.kv, parseConfigWords(words));
    deps.onConfig?.(next);
    return next;
  }

  const agreement = (days = 7) => agreementReport(deps.db, now() - days * DAY_MS, DECISIONS_USD_PER_MILLION_INPUT);

  const items = (filter: { projectId?: string; states?: ItemState[]; kinds?: ItemKind[]; limit?: number } = {}): Item[] => listItems(deps.db, filter);
  const signals = (kind?: string, limit = 30) => listSignals(deps.db, { ...(kind ? { kind } : {}), limit });

  return { status, review, label, configure, agreement, items, signals };
}
export type Ops = ReturnType<typeof createOps>;

