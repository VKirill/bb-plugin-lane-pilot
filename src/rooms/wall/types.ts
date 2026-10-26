import { createHash } from "node:crypto";

/**
 * The wall journal and the night loop (SMA P1-1; Maslov #31448 «чинит не случай, а класс», the dialogue of 2026-10-22 «3 ходки … меняется
 * перспектива … беклог»; atlas delta D0-1 / D1-1). Vocabulary shared by the room's pure modules.
 *
 * A *wall* is a failure that repeats. A *class* is its signature: failure class + normalised reason (the LP version and the project are
 * dimensions of the journal, not part of the class). The journal groups one night's failures by (class, LP version, project).
 */

/** The recurrence ladder (Maslov: 3/10, 5/100, 6/500): at most `max` failures of a class among the last `window` finished attempts. */
export const RUNGS = [
  { window: 10, max: 3 },
  { window: 100, max: 5 },
  { window: 500, max: 6 },
] as const;

/** Origins that are Lane Pilot's own side; a class from one of them is picked whatever its recurrence. */
export const LANE_ORIGINS: readonly string[] = ["orchestrator", "harness", "infra"];

export type Sources = { attempt: number; triage: number; gate: number; stage: number; log: number };
export const EMPTY_SOURCES: Sources = { attempt: 0, triage: 0, gate: 0, stage: 0, log: 0 };

export type HuntState = "none" | "running" | "usable" | "unknown";
export type LadderStage = "moves" | "hunt" | "informed" | "backlog";

/** A class of failures as the night sees it. */
export type WallClass = {
  classKey: string;
  failureClass: string;
  reasonNorm: string;
  origin: string;
  firstSeen: number;
  lastSeen: number;
  total: number;
  /** Failures among the last 10 / 100 / 500 finished real attempts, and how many attempts those windows really hold. */
  counts: [number, number, number];
  windows: [number, number, number];
  rung: 0 | 1 | 2 | 3;
  state: "open" | "closed";
  /** Seen in the last 7 days / last 24 hours. */
  recur7: number;
  recur1: number;
  /** The wall ladder of the class (ladder.ts). */
  failedMoves: number;
  hunt: HuntState;
  afterHuntFailed: number;
  stage: LadderStage;
};

export const sha12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * Statuses of one repair row. `queued` waits for the self-repair tick, `merged` waits for a release, `deployed` for its acceptance.
 * `rollback_pending`: the acceptance is red and the revert of the merge did not go through yet; the tick tries it again (open, so the class
 * is not repaired on top of a merge that should come out). `unproven`: no evidence came, neither for nor against the repair (closed, not accepted).
 */
export const REPAIR_STATES = ["queued", "running", "fixed", "merged", "deployed", "accepted", "rolled_back", "red", "held", "released", "failed", "rollback_pending", "unproven"] as const;
export type RepairState = (typeof REPAIR_STATES)[number];
export const OPEN_REPAIR_STATES: readonly RepairState[] = ["queued", "running", "fixed", "merged", "deployed", "held", "rollback_pending"];

export type NightPick = { classKey: string; why: string; round: number; role: "engineer" | "informed" };
export type NightSummary = {
  night: string;
  startedAt: number;
  dryRun: boolean;
  classesSeen: number;
  picked: NightPick[];
  morning: Array<{ classKey: string; why: string }>;
  hunts: string[];
  backlog: string[];
  spendTokens: number;
  capTokens: number;
  stoppedBy: string | null;
};

/** x.y.z compared as numbers; anything else sorts first. */
export function compareVersions(a: string, b: string): number {
  const parts = (text: string) => (/^\d+\.\d+\.\d+$/.test(text) ? text.split(".").map(Number) : [-1, 0, 0]);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
