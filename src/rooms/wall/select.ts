import { shouldStopCycle } from "../policy";
import { ladderStep } from "./ladder";
import { LANE_ORIGINS, compareVersions, type WallClass } from "./types";

/**
 * Which classes the night works on: at most `max` (Maslov: 1-3 recommendations per cycle). A class qualifies when it is open (not yet within
 * 3/10, 5/100, 6/500) or happened `recurrenceFloor` times in 7 days, it was seen in the last 24 hours, it has no repair under way, it is not
 * in the backlog, and either it is on Lane Pilot's side (orchestrator / harness / infra) or it recurs `recurrenceFloor` times in 7 days
 * with no open repair. The rest, with the reason, go to the morning list.
 */
export type SelectInput = {
  classes: readonly WallClass[];
  max: number;
  walks: number;
  recurrenceFloor: number;
  /**
   * The release that runs now, and the versions each class was seen under in the last day. A failure that happened only under older versions may be
   * exactly what the release since then fixed (the watcher's own rule): the class waits to happen again under the running one.
   */
  runningVersion?: string;
  seenVersions?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Classes with a repair under way (queued ... deployed), and the repair rounds each already spent tonight. */
  openRepair: ReadonlySet<string>;
  roundsTonight: ReadonlyMap<string, number>;
  roundsPerNight: number;
  /** The bench score after each cycle of the series, oldest first (policy/cycle.ts); two cycles without improvement end the series. */
  cycleScores?: readonly number[];
  /** Tokens still free tonight; a class needs `roundCost` of them. */
  tokensLeft: number;
  roundCost: number;
};

/**
 * The cycle history `shouldStopCycle` reads: the bench score before the first judged repair, then the score after each COMPARISON. Repairs that
 * shipped in one release are judged by one comparison and carry the same numbers, so they are one cycle: three repairs of a night counted as
 * three cycles and stopped the series on [.5, .125, .625, .625, .625] (nights of 2026-10-26), while the cycles were [.5, .125, .625].
 * A comparison is told apart by the arms it compared (`benchCompare`); a repair judged before the arms were kept falls back to its two scores.
 */
export function cycleScoresOf(rows: ReadonlyArray<{ acceptance: Record<string, unknown> | null }>): number[] {
  const judged = rows.map((row) => row.acceptance as { benchScore?: unknown; baselineScore?: unknown; benchCompare?: { base?: unknown; arm?: unknown } } | null).filter((acceptance) => typeof acceptance?.benchScore === "number");
  if (!judged.length) return [];
  const seen = new Set<string>();
  const scores: number[] = [];
  for (const acceptance of judged) {
    const key = acceptance!.benchCompare ? `${String(acceptance!.benchCompare.base)}>${String(acceptance!.benchCompare.arm)}` : `${String(acceptance!.baselineScore ?? "-")}>${String(acceptance!.benchScore)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scores.push(acceptance!.benchScore as number);
  }
  return [typeof judged[0]!.baselineScore === "number" ? judged[0]!.baselineScore : 0, ...scores];
}

export type Chosen = { classKey: string; why: string; round: number; role: "engineer" | "informed" };
export type Skip = { classKey: string; why: string };
export type Selection = { picked: Chosen[]; morning: Skip[]; stoppedBy: string | null };

export function selectClasses(input: SelectInput): Selection {
  const picked: Chosen[] = [], morning: Skip[] = [];
  if (input.cycleScores && shouldStopCycle(input.cycleScores)) {
    return { picked, morning: [], stoppedBy: "two cycles in a row without a bench improvement (shouldStopCycle): the series is over" };
  }
  const ranked = input.classes.filter((row) => row.recur1 > 0).sort((a, b) => {
    const lane = Number(LANE_ORIGINS.includes(b.origin)) - Number(LANE_ORIGINS.includes(a.origin));
    return lane || b.recur7 - a.recur7 || b.recur1 - a.recur1 || a.classKey.localeCompare(b.classKey);
  });
  let left = input.tokensLeft;
  for (const row of ranked) {
    const skip = (why: string) => { morning.push({ classKey: row.classKey, why }); };
    const lane = LANE_ORIGINS.includes(row.origin);
    if (row.state === "closed" && row.recur7 < input.recurrenceFloor) { skip(`within the bar (${row.counts[0]}/${row.windows[0]}, ${row.counts[1]}/${row.windows[1]}, ${row.counts[2]}/${row.windows[2]}): watched, not repaired`); continue; }
    if (row.stage === "backlog") { skip("in the backlog: waits for a person"); continue; }
    const seen = input.seenVersions?.get(row.classKey);
    if (input.runningVersion && seen && seen.size && ![...seen].some((version) => version === "" || compareVersions(version, input.runningVersion!) >= 0)) {
      skip(`seen only under ${[...seen].sort(compareVersions).at(-1)}, ${input.runningVersion} runs now: a release since may have fixed it, it waits to happen again`);
      continue;
    }
    if (input.openRepair.has(row.classKey)) { skip("a repair is already under way"); continue; }
    if (!lane && row.recur7 < input.recurrenceFloor) { skip(`origin ${row.origin} and ${row.recur7} in 7 days (below ${input.recurrenceFloor}): not Lane Pilot's to repair`); continue; }
    // A writer's own red check is the task's road (red, the retry, green), not a fault a night move in Lane Pilot's code can take away:
    // repaired every night, its recurrence never fell (task:3a88e7517c7a, nights 2026-10-24/25). Lane Pilot's share of red checks is its
    // own class (classKeyOf) and is repaired as before.
    if (!lane && row.failureClass === "task" && row.reasonNorm.startsWith("verification failed (<check>)")) { skip(`the writers' own red checks (origin ${row.origin}, ${row.recur7} in 7 days): the retry is their road; watched, not repaired`); continue; }
    if (picked.length >= input.max) { skip(`more than ${input.max} classes tonight: it waits for the next night`); continue; }
    const step = ladderStep({ failedMoves: row.failedMoves, hunt: row.hunt, afterHuntFailed: row.afterHuntFailed }, input.walks);
    if (step.step === "wait_hunt") { skip(step.why); continue; }
    if (step.step === "hunt") { skip("its moves are spent: the hunt is next, then one informed move"); continue; }
    if (step.step === "backlog") { skip(step.why); continue; }
    if ((input.roundsTonight.get(row.classKey) ?? 0) >= input.roundsPerNight) { skip(`${input.roundsPerNight} rounds already tonight`); continue; }
    if (left < input.roundCost) { skip("the night's token cap would be passed"); continue; }
    left -= input.roundCost;
    picked.push({ classKey: row.classKey, why: lane ? `origin ${row.origin}, rung ${row.rung}, ${row.recur1} today / ${row.recur7} in 7 days` : `recurs ${row.recur7} times in 7 days without a repair`,
      round: (input.roundsTonight.get(row.classKey) ?? 0) + 1, role: step.step === "informed_move" ? "informed" : "engineer" });
  }
  return { picked, morning, stoppedBy: null };
}
