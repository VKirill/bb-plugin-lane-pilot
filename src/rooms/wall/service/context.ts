import { sha256Hex } from "@lane-pilot/kit";
import type { LoopSubject } from "../../contracts";
import { statsEpochMs, settingValue, STATS_EPOCH_SETTING } from "../../storage";
import type { WallConfig } from "../config";
import type { WallDb } from "../journal";
import type { WallDeps } from "../service";

export const DAY = 86_400_000;
export const QUEUED_STALE_MS = 12 * 3_600_000;
/** A revert that did not go through is tried again at most this often and this many times; then the diagnosis goes to the backlog. */
export const ROLLBACK_RETRY_MS = 10 * 60_000;
export const ROLLBACK_TRIES = 6;
export type Rollback = { attempts: number; lastError: string; lastAt: number; reason: string; gaveUp?: boolean };

/** stats.epoch: walls, reruns and repairs count only records after it (default 2026-10-31); older rows stay but are not counted. */
export const statsEpoch = (db: WallDb): number =>
  statsEpochMs(settingValue(db as never, "*", STATS_EPOCH_SETTING) ?? undefined);

/** The hash of what a task asks, without its id (a redispatch under «P1.2» is the same ask) and of its plan. */
export function askSha(task: unknown, plan: string): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([key]) => key !== "id").sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => [key, sorted(value)]))
    : item;
  return sha256Hex(`${JSON.stringify(sorted(task))}\n${plan}`).slice(0, 16);
}
export const taskWallKey = (family: string, runId: string, classKey: string): string => `task:${sha256Hex(`${runId}|${family}|${classKey}`).slice(0, 12)}`;
export const classWallKey = (classKey: string): string => `class:${classKey}`;

/** Loop walls (a phase stage, a failed verification, a topic) are walls of kind task whose key starts with this. */
export const LOOP_PREFIX = "loop:";
export const loopWallKey = (kind: LoopSubject["kind"], id: string): string => `${LOOP_PREFIX}${kind}:${sha256Hex(id).slice(0, 12)}`;

/** The locals of `createWall` the split-out rooms share: the same statements, the shared state passed explicitly. */
export type WallCtx = {
  db: WallDb;
  kv: WallDeps["kv"];
  ports: WallDeps["ports"];
  log(line: string): void;
  deps: WallDeps;
  config(): Promise<WallConfig>;
  cycleScores(): number[];
};
