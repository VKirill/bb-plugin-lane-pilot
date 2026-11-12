import { loadConfig, parseConfigWords, saveConfig, type LearningConfig } from "./config";
import { DAY_MS, listItems, startOfDay, usageToday, type Db, type Item, type ItemKind, type ItemState } from "./store";

/**
 * What the owner (or the PM, asked by the owner) reads and changes: the status of the learning, the learned items, the settings.
 * One set of functions behind the PM's tool action `lane_pilot_memory {action:"learned"}` and the CLI `bb lane-pilot learning …`;
 * neither adds a rule of its own.
 */
export type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };

/** What the last night run did, kept in the key-value store for `status`. */
export const LAST_NIGHT_KEY = "learning:last-night";
export type NightReport = { at: number; projects: number; batches: number; read: number; items: number; adopted: number; waiting: number; duplicates: number; noted: number; dropped: number; stopped?: string };

export type OpsDeps = {
  db: Db; kv: Kv; now?(): number;
  /** Per project, how full the memory shelves are (housekeeping.ts). */
  memoryFill?(): unknown;
  /** Applies a changed config (rule budgets). */
  onConfig?(config: LearningConfig): void;
};

export function createOps(deps: OpsDeps) {
  const now = deps.now ?? Date.now;

  async function status() {
    const config = await loadConfig(deps.kv), at = now(), week = at - 7 * DAY_MS;
    const byState = Object.fromEntries((deps.db.prepare("SELECT state, count(*) AS n FROM lane_pilot_learning_obs GROUP BY state").all() as Array<{ state: string; n: number }>).map((row) => [row.state, row.n]));
    const skipped = Object.fromEntries((deps.db.prepare("SELECT skip_reason AS reason, count(*) AS n FROM lane_pilot_learning_obs WHERE judged_at>=? AND state='skipped' GROUP BY skip_reason").all(week) as Array<{ reason: string | null; n: number }>).map((row) => [row.reason ?? "?", row.n]));
    const items = Object.fromEntries((deps.db.prepare("SELECT state, count(*) AS n FROM lane_pilot_learning_item GROUP BY state").all() as Array<{ state: string; n: number }>).map((row) => [row.state, row.n]));
    const waiting = (deps.db.prepare("SELECT count(*) AS n FROM lane_pilot_learning_obs WHERE state='candidate' AND body IS NOT NULL").get() as { n: number }).n;
    const usage = usageToday(deps.db, at);
    return {
      enabled: config.enabled,
      how: "The owner's own messages are kept as candidates after a rule-based filter (machine text and short acknowledgements are dropped). One night run reads the day's candidates in batches with the rules analyzer model and writes the lessons; no per-message judge.",
      candidatesWaiting: waiting, observations: byState, skippedLast7Days: skipped,
      today: { candidates: usage.candidates, candidateCap: config.dailyCandidateCap, since: startOfDay(at) },
      lastNightRun: (await deps.kv.get<NightReport>(LAST_NIGHT_KEY)) ?? null,
      items, waitingForOwner: listItems(deps.db, { states: ["pending_owner"], limit: 100 }).length,
      ...(deps.memoryFill ? { memory: deps.memoryFill() } : {}),
    };
  }

  async function configure(words: readonly string[]) {
    if (!words.length) return await loadConfig(deps.kv);
    const next = await saveConfig(deps.kv, parseConfigWords(words));
    deps.onConfig?.(next);
    return next;
  }

  const items = (filter: { projectId?: string; states?: ItemState[]; kinds?: ItemKind[]; limit?: number } = {}): Item[] => listItems(deps.db, filter);

  return { status, configure, items };
}
export type Ops = ReturnType<typeof createOps>;
