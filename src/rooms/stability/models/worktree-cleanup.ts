import { OPEN_ATTEMPT_STATES, RETRY_ELIGIBLE } from "../../contracts";
import type { SweepDecision } from "../../worktree";

/** When the re-arm pass first ran on this install: a disarm whose term ended before it is listed, not rewritten. */
export const REARM_SINCE_KEY = "lp.protection.rearm-since";

export type JanitorOutcome = {
  removed?: string[]; freedBytes?: number;
  kept?: Array<{ path: string; reason: string; ageMs: number; bytes: number }>;
  tmpRemoved?: string[]; tmpFreedBytes?: number; errors?: string[];
};

export const JANITOR_OPEN_STATES: readonly string[] = OPEN_ATTEMPT_STATES;
/**
 * Ended attempts that can still go on in their own worktree: a writer question answered, a contract fixed in place or
 * a retry continues one. Their copy waits out the grace: magicseo T3.3 (2026-10-30) blocked on a question at
 * 18:13:58, the hourly reconcile removed its worktree at 18:14:02, and the reopened writer found no folder
 * (spawn /bin/bash ENOENT) and moved itself to the main checkout.
 */
export const JANITOR_REOPENABLE_STATES: readonly string[] = [...RETRY_ELIGIBLE, "blocked"];

/** One decision of the daily pass as the hub reports it: the machine's decision, with the machine and (for a BB environment) BB's own answer. */
export type HubDecision = SweepDecision & {
  host: string;
  /** A real pass's BB environment: `asked` once BB took the delete (it tears down in the background), `removed` once BB says it is gone. */
  outcome?: "asked" | "removed";
};

/** What one pass of the graph lp.worktree-cleanup reports: its status, the counts and one line for the board's run output. */
export type CleanupPassOutcome = {
  status: "ok" | "off" | "error"; removed: number; freedBytes: number; kept: number; report: string;
  /** Full machine-readable hourly candidates from the daily pass, including dry runs (which do not persist a janitor row). */
  hourlyRemoved: Array<{ host: string; path: string }>;
  hourlyTmpRemoved: Array<{ host: string; path: string }>;
  /** The daily pass: every linked worktree looked at on every machine, with its decision and reason. */
  decisions?: HubDecision[];
  /** The daily pass: the bounded home search on each machine (roots, depth, repositories, folders read, time). */
  search?: Array<{ host: string; roots: string[]; maxDepth: number; repos: number; dirs: number; ms: number; truncated: boolean }>;
};

export const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;

/** A worktree whose folder or branch moved within this window is never swept: another agent may be working in it right now. */
export const WORKTREE_YOUNG_MS = 24 * 3_600_000;
/** The owner's line of the daily pass: one per distinct kept list (`worktree-cleanup:<hash>`), never one per pass. */
export const CLEANUP_ITEM_PREFIX = "worktree-cleanup:";
/** The owner's line for linked worktrees outside the managed classes: listed, never removed; one line per distinct list (`worktree-outside:<hash>`). */
export const OUTSIDE_ITEM_PREFIX = "worktree-outside:";
/** How long a real pass re-reads the environments it asked BB to remove before it reports them as «asked», not removed. */
export const TEARDOWN_WAIT_MS = 5_000;

export const WORKTREE_CLEANUP_USAGE = "bb lane-pilot worktree-cleanup [--daily] [--dry-run] [--json]";
