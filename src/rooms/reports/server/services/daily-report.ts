import { workflowWindowStats } from "@lane-pilot/workflow-engine";
import { DRILL_SANDBOX_PROJECT_IDS, FAILED_ATTEMPT_STATES, isDrillTask } from "../../../contracts";
import { listDeferrals } from "../../../deferral/server";
import { listPathCandidates, type Candidate, type ListPathCandidatesInput } from "../../../lead/server";
import { listOutages } from "../../../outage";
import { ownerWaitingCounts, tableExists, type OwnerItemSweep } from "../../../owner-waiting";
import { loadPushConfig, readOwnerConfigKey, writeOwnerConfigKey } from "../../../owner-waiting/server";
import { listAttemptOutcomesSince, type LanePilotDatabase } from "../../../storage";
import {
  DAILY_DRY_KEY,
  DAILY_SENT_KEY,
  composeDailyReport,
  dailyDue,
  localDayHour,
  type DailySummary,
} from "../../models/daily-report";
import { TelegramNotReadyError, type TelegramSend } from "../../models/telegram";

const WINDOW_MS = 24 * 3_600_000;

export type PathCandidatesReader = (
  db: LanePilotDatabase,
  input?: ListPathCandidatesInput,
) => { free: Candidate[]; branch: Candidate[] };

export type DailyDeps = {
  db: LanePilotDatabase;
  now?: () => number;
  windowMs?: number;
  sweeps?: readonly OwnerItemSweep[];
  pathCandidates?: PathCandidatesReader;
  log?: (message: string) => void;
};

export type DailyReportRunDeps = {
  db: LanePilotDatabase;
  now: number;
  force?: boolean;
  send: TelegramSend;
  log: (message: string) => void;
  pathCandidates?: PathCandidatesReader;
};

export type DailyReportOutcome = {
  sent: boolean;
  reason: string;
  day: string;
  text?: string;
};

function candidateScore(candidate: Candidate): number {
  return candidate.count * Math.max(candidate.costMicroUsd, 1);
}

function summarizePathCandidates(
  deps: Pick<DailyDeps, "db" | "pathCandidates" | "log">,
  now: number,
): DailySummary["paths"] {
  const read = deps.pathCandidates ?? listPathCandidates;
  try {
    const { free, branch } = read(deps.db, {
      now,
      log: deps.log ? { warn: deps.log } : undefined,
    });
    const all = [...free, ...branch];
    if (all.length === 0) return { candidates: 0, top: null };
    all.sort(
      (a, b) =>
        candidateScore(b) - candidateScore(a)
        || b.lastSeen - a.lastSeen
        || a.key.localeCompare(b.key),
    );
    const best = all[0]!;
    return {
      candidates: all.length,
      top: { label: best.label, count: best.count },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    deps.log?.(`daily report paths failed: ${message}`);
    return { candidates: 0, top: null };
  }
}

/** Collects 24h status facts directly from SQLite and formats the compact daily digest. */
export async function buildDailyReport(deps: DailyDeps): Promise<string> {
  const now = deps.now?.() ?? Date.now();
  const since = now - (deps.windowMs ?? WINDOW_MS);
  const { day } = localDayHour(now, "UTC");

  const attempts = listAttemptOutcomesSince(deps.db, since).filter(
    (row) => !DRILL_SANDBOX_PROJECT_IDS.includes(row.projectId) && !isDrillTask(row.taskId),
  );
  let accepted = 0;
  let failed = 0;
  for (const row of attempts) {
    if (row.state === "accepted") accepted += 1;
    else if (FAILED_ATTEMPT_STATES.includes(row.state as (typeof FAILED_ATTEMPT_STATES)[number])) failed += 1;
  }

  const wf = tableExists(deps.db, "lane_pilot_wf_run") && tableExists(deps.db, "lane_pilot_wf_step")
    ? workflowWindowStats(deps.db, since)
    : { runs: 0, succeeded: 0, failed: 0, costUsd: null, costState: "not_measured" as const, measuredSteps: 0, notMeasuredSteps: 0 };

  const waiting = tableExists(deps.db, "lane_pilot_owner_item")
    ? ownerWaitingCounts(deps.db, now, deps.sweeps ?? [])
    : { overdue: 0, open: 0, inbox: 0 };

  let deferralsOpen = 0;
  let deferralsOverdue = 0;
  if (tableExists(deps.db, "lane_pilot_deferral")) {
    const activeDeferrals = listDeferrals(deps.db, { states: ["open", "overdue"] });
    for (const row of activeDeferrals) {
      deferralsOpen += 1;
      if (row.state === "overdue" || (row.dueAt !== null && row.dueAt < now)) deferralsOverdue += 1;
    }
  }

  const outages = tableExists(deps.db, "lane_pilot_outage") ? listOutages(deps.db, since).length : 0;
  const paths = summarizePathCandidates(deps, now);

  return composeDailyReport({
    day,
    accepted,
    failed,
    total: attempts.length,
    workflowRuns: wf.runs,
    workflowSucceeded: wf.succeeded,
    workflowFailed: wf.failed,
    costUsd: wf.costUsd,
    costState: wf.costState,
    measuredSteps: wf.measuredSteps,
    notMeasuredSteps: wf.notMeasuredSteps,
    waitingOpen: waiting.inbox,
    waitingOverdue: waiting.overdue,
    deferralsOpen,
    deferralsOverdue,
    outages,
    paths,
  });
}

/** Checks daily-report schedule state, builds the digest, and sends or dry-runs it once per local day. */
export async function runDailyReport(deps: DailyReportRunDeps): Promise<DailyReportOutcome> {
  const cfg = loadPushConfig(deps.db);
  const dryRun = cfg.dryRun === true;
  const markKey = dryRun ? DAILY_DRY_KEY : DAILY_SENT_KEY;
  const due = dailyDue(deps.now, cfg.timezone, readOwnerConfigKey(deps.db, markKey));
  if (!due.due && !deps.force) {
    return { sent: false, reason: "not_due", day: due.day };
  }
  const text = await buildDailyReport({
    db: deps.db,
    now: () => deps.now,
    pathCandidates: deps.pathCandidates,
    log: deps.log,
  });
  if (dryRun) {
    deps.log(`[daily-report dry-run ${due.day}]\n${text}`);
    writeOwnerConfigKey(deps.db, DAILY_DRY_KEY, due.day, deps.now);
    return { sent: false, reason: "dry_run", day: due.day, text };
  }
  try {
    await deps.send(text);
  } catch (cause) {
    const reason = cause instanceof TelegramNotReadyError ? "telegram_not_ready" : "send_failed";
    deps.log(`daily report: ${reason}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return { sent: false, reason, day: due.day };
  }
  writeOwnerConfigKey(deps.db, DAILY_SENT_KEY, due.day, deps.now);
  return { sent: true, reason: "", day: due.day, text };
}
