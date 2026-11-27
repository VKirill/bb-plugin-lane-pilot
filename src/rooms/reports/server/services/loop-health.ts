import { KILL_CRITERIA, LOOP_NAMES, type LoopMode } from "@lane-pilot/contracts";
import {
  draftPublishedAt,
  listDraftsBySources,
  wfCountRunsInWindow,
  type DraftRow,
} from "@lane-pilot/workflow-engine";
import { evolveLoopHealthStats } from "../../../evolve/server";
import { specialistConclusiveHealth8w } from "../../../specialist/server";
import { readLoopModes, type LanePilotDatabase } from "../../../storage";
import type { LoopHealthEntry } from "../../models/loop-health";

const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;

export type LoopHealthLogger =
  | ((message: string) => void)
  | { debug?: (message: string) => void; warn?: (message: string) => void };

export type LoopHealthOptions = {
  now?: number;
  projectId?: string | null;
  log?: LoopHealthLogger;
};

type SettledDraftOutcome = {
  draft: DraftRow;
  accepted: boolean;
};

function emitDebug(log: LoopHealthLogger | undefined, message: string): void {
  if (!log) return;
  if (typeof log === "function") log(message);
  else log.debug?.(message);
}

function evaluateDraftOutcomes(
  db: LanePilotDatabase,
  now: number,
  sources: readonly string[],
  spec: { lastDraftsWindow: number; minAcceptedOfLast: number; staleDraftDays: number },
) {
  const rows = listDraftsBySources(db as never, sources);
  const staleCutoffMs = spec.staleDraftDays * DAY_MS;
  const settled: SettledDraftOutcome[] = [];
  const acceptedDrafts: DraftRow[] = [];
  let abandonedCount = 0;
  let pendingCount = 0;

  for (const draft of rows) {
    const accepted = draft.status === "published" || draft.publishedVersion !== null;
    if (accepted) {
      settled.push({ draft, accepted: true });
      acceptedDrafts.push(draft);
    } else if (now - draft.updatedAt > staleCutoffMs) {
      settled.push({ draft, accepted: false });
      abandonedCount += 1;
    } else {
      pendingCount += 1;
    }
  }

  const recent = settled.slice(0, spec.lastDraftsWindow);
  const acceptedInRecent = recent.filter((item) => item.accepted).length;
  const draftsFailing = recent.length >= spec.lastDraftsWindow && acceptedInRecent < spec.minAcceptedOfLast;

  return {
    settledCount: settled.length,
    recentCount: recent.length,
    acceptedInRecent,
    acceptedTotal: acceptedDrafts.length,
    abandonedCount,
    pendingCount,
    acceptedDrafts,
    draftIds: recent.map((item) => item.draft.id),
    draftsFailing,
  };
}

function computeDiscovery(db: LanePilotDatabase, now: number, mode: LoopMode): LoopHealthEntry {
  const spec = KILL_CRITERIA.discovery;
  const drafts = evaluateDraftOutcomes(db, now, ["path-capture"], spec);
  const postPublishWindowMs = spec.postPublishDays * DAY_MS;

  const publishedChecks: Array<{
    draftId: string;
    workflowId: string;
    publishedAt: number;
    matured: boolean;
    runs30d: number;
  }> = [];

  for (const draft of drafts.acceptedDrafts) {
    const publishedAt = draftPublishedAt(db as never, draft);
    if (publishedAt === null) continue;
    const matured = now - publishedAt >= postPublishWindowMs;
    const runs30d = matured ? wfCountRunsInWindow(db, draft.workflowId, publishedAt, publishedAt + postPublishWindowMs) : 0;
    publishedChecks.push({
      draftId: draft.id,
      workflowId: draft.workflowId,
      publishedAt,
      matured,
      runs30d,
    });
  }

  const lowRunGraphs = publishedChecks.filter((item) => item.matured && item.runs30d < spec.minRunsIn30Days);
  const runsFailing = lowRunGraphs.length > 0;
  const failing = drafts.draftsFailing || runsFailing;

  let metric: number | null;
  let threshold: number;
  let reason = "ok";

  if (runsFailing && !drafts.draftsFailing) {
    metric = Math.min(...lowRunGraphs.map((item) => item.runs30d));
    threshold = spec.minRunsIn30Days;
    reason = "low_post_publish_runs";
  } else {
    metric = drafts.recentCount > 0 ? drafts.acceptedInRecent : null;
    threshold = spec.minAcceptedOfLast;
    if (drafts.draftsFailing && runsFailing) reason = "low_acceptance_and_low_runs";
    else if (drafts.draftsFailing) reason = "low_draft_acceptance";
  }

  return {
    loop: "discovery",
    mode,
    metric,
    threshold,
    failing,
    evidence: {
      settledCount: drafts.settledCount,
      recentCount: drafts.recentCount,
      acceptedInRecent: drafts.acceptedInRecent,
      abandonedCount: drafts.abandonedCount,
      pendingCount: drafts.pendingCount,
      draftIds: drafts.draftIds,
      publishedChecks,
      lowRunGraphs: lowRunGraphs.map((item) => ({ workflowId: item.workflowId, runs30d: item.runs30d })),
      reason,
    },
  };
}

function computeDraftAcceptanceLoop(
  db: LanePilotDatabase,
  now: number,
  loop: "branches" | "templates",
  mode: LoopMode,
  sources: readonly string[],
  spec: { lastDraftsWindow: number; minAcceptedOfLast: number; staleDraftDays: number },
): LoopHealthEntry {
  const drafts = evaluateDraftOutcomes(db, now, sources, spec);
  return {
    loop,
    mode,
    metric: drafts.recentCount > 0 ? drafts.acceptedInRecent : null,
    threshold: spec.minAcceptedOfLast,
    failing: drafts.draftsFailing,
    evidence: {
      settledCount: drafts.settledCount,
      recentCount: drafts.recentCount,
      acceptedInRecent: drafts.acceptedInRecent,
      abandonedCount: drafts.abandonedCount,
      pendingCount: drafts.pendingCount,
      draftIds: drafts.draftIds,
      reason: drafts.draftsFailing ? "low_draft_acceptance" : "ok",
    },
  };
}

function computeEvolve(db: LanePilotDatabase, now: number, mode: LoopMode): LoopHealthEntry {
  const spec = KILL_CRITERIA.evolve;
  const stats = evolveLoopHealthStats(db, {
    now,
    windowDays4w: spec.windowWeeks * DAYS_PER_WEEK,
    rollbackWindowDays: spec.rollbackWindowDays,
  });

  const stagnant = stats.proposed4w >= spec.minProposedWithoutWin && stats.promoted4w === 0;
  const tooManyRollbacks = stats.rollbacks30d >= spec.minRollbacksIn30Days;
  const failing = stagnant || tooManyRollbacks;

  let metric: number | null;
  let threshold: number;
  let reason = "ok";

  if (tooManyRollbacks) {
    metric = stats.rollbacks30d;
    threshold = spec.minRollbacksIn30Days;
    reason = stagnant ? "stagnant_and_rollbacks" : "rollbacks_30d";
  } else if (stagnant) {
    metric = stats.promoted4w;
    threshold = 1;
    reason = "no_promotions_4w";
  } else {
    metric = stats.proposed4w > 0 || stats.promoted4w > 0 ? stats.promoted4w : null;
    threshold = 1;
  }

  return {
    loop: "evolve",
    mode,
    metric,
    threshold,
    failing,
    evidence: {
      proposed4w: stats.proposed4w,
      promoted4w: stats.promoted4w,
      rollbacks30d: stats.rollbacks30d,
      rollbackIds: stats.rollbackIds,
      reason,
    },
  };
}

function computeEmployee(db: LanePilotDatabase, now: number, mode: LoopMode): LoopHealthEntry {
  const spec = KILL_CRITERIA.employee;
  const stats = specialistConclusiveHealth8w(db, {
    now,
    windowDays: spec.windowWeeks * DAYS_PER_WEEK,
  });

  const failing =
    stats.totalVerdicts8w > 0 &&
    stats.conclusiveShare8w !== null &&
    stats.conclusiveShare8w < spec.minConclusiveShare8w;

  return {
    loop: "employee",
    mode,
    metric: stats.conclusiveShare8w,
    threshold: spec.minConclusiveShare8w,
    failing,
    evidence: {
      conclusiveCount8w: stats.conclusiveCount8w,
      inconclusiveCount8w: stats.inconclusiveCount8w,
      totalVerdicts8w: stats.totalVerdicts8w,
      conclusiveShare8w: stats.conclusiveShare8w,
      cases: stats.cases,
      reason: failing ? "low_conclusive_share_8w" : "ok",
    },
  };
}

/**
 * Evaluates M19 kill criteria for all 5 learning loops strictly from persisted SQLite records.
 * Failing loops are surfaced for the owner's weekly review desk without mutating loop modes.
 */
export function loopHealth(db: LanePilotDatabase, options: LoopHealthOptions = {}): LoopHealthEntry[] {
  const now = options.now ?? Date.now();
  const modes = readLoopModes(db, options.projectId);

  const byLoop: Record<(typeof LOOP_NAMES)[number], LoopHealthEntry> = {
    discovery: computeDiscovery(db, now, modes.discovery),
    branches: computeDraftAcceptanceLoop(
      db,
      now,
      "branches",
      modes.branches,
      ["branch-capture", "branch"],
      KILL_CRITERIA.branches,
    ),
    evolve: computeEvolve(db, now, modes.evolve),
    employee: computeEmployee(db, now, modes.employee),
    templates: computeDraftAcceptanceLoop(
      db,
      now,
      "templates",
      modes.templates,
      ["project-template"],
      KILL_CRITERIA.templates,
    ),
  };

  const results = LOOP_NAMES.map((loop) => byLoop[loop]);
  for (const entry of results) {
    emitDebug(options.log, `loop health loop=${entry.loop} failing=${entry.failing} metric=${entry.metric ?? "null"}`);
  }
  return results;
}
