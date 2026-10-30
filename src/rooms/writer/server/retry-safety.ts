import type { LanePilotDatabase } from "../../storage";
import { runOnHost } from "@lane-pilot/host-calls";
import { redactKnown } from "@lane-pilot/kit";
import type { TaskV2 } from "../../contracts";

/**
 * The safety gate in front of an automatic retry (hive-audit H-04, `writer.retry_safety`, on by default). An auto-retry is
 * safe only while nothing outside the attempt touched its work area. Three signs stop it with a reason a human reads:
 * - foreign work: commits or file writes in the failed attempt's worktree dated after the attempt ended — the owner or
 *   another process edited there, and a resume-in-place would build on or overwrite that input;
 * - tampered evidence: the same post-end modification inside `.agents/` artifacts — check receipts rewritten after they
 *   were written read as a forged pass;
 * - secret residue: a catalog secret the task's checks used still sits in the worktree diff — retrying repeats the leak.
 * A worktree that cannot be inspected (no git, host error, live folder) is not blocked: the gate refuses to invent stops.
 */
export async function retrySafetyStop(input: {
  db: LanePilotDatabase; host: Parameters<typeof runOnHost>[0]; hostId: string;
  task: TaskV2; attemptId: string; liveFolder: boolean; now?: number;
}): Promise<string | null> {
  const { db, host, hostId, task, attemptId, liveFolder } = input;
  const row = db.prepare("SELECT workspace_path, updated_at FROM lane_pilot_attempt WHERE id=?").get(attemptId) as
    { workspace_path: string | null; updated_at: number } | undefined;
  const workspace = row?.workspace_path;
  if (!workspace || liveFolder) return null;
  const endedAt = row!.updated_at;
  const epoch = Math.floor(endedAt / 1000);
  const scan = await runOnHost(host, {
    hostId, cwd: workspace, timeoutSec: 30, timeoutMs: 35_000,
    command: `git log --since=@${epoch} --oneline -10 2>/dev/null; find . -path ./.git -prune -o -type f -newermt @${epoch} -print 2>/dev/null | head -80`,
  }).catch(() => null);
  if (scan && scan.exitCode === 0) {
    const lines = scan.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    // `git log --oneline` rows are abbreviated sha plus subject; `find` rows are ./-relative. Anything else is ignored,
    // so a host answering a different probe's stub output cannot look like foreign work.
    const commits = lines.filter((line) => /^[0-9a-f]{6,40}\s/.test(line));
    const touched = lines.filter((line) => line.startsWith("./"));
    if (commits.length) {
      return `retry_safety: ${workspace} has ${commits.length} commit(s) made after attempt ${attemptId} ended (${commits[0]}); ` +
        "the owner or another process worked there — inspect the worktree and dispatch again manually instead of an automatic retry";
    }
    const evidence = touched.find((path) => path.includes("/.agents/") || path.startsWith("./.agents/"));
    if (evidence) {
      return `retry_safety: check evidence ${evidence} was modified after attempt ${attemptId} ended; a rewritten receipt can be a forged pass — inspect it and dispatch again manually`;
    }
    if (touched.length) {
      return `retry_safety: ${touched.length} file(s) in ${workspace} changed after attempt ${attemptId} ended (${touched[0]}); ` +
        "an automatic retry would build on edits it did not make — inspect the worktree and dispatch again manually";
    }
  }
  const usedSecrets = task.verification.some((check) => check.secrets?.length)
    || !!db.prepare("SELECT 1 FROM lane_pilot_secret_issuance WHERE task_id=? LIMIT 1").get(task.id);
  if (usedSecrets) {
    const diff = await runOnHost(host, {
      hostId, cwd: workspace, timeoutSec: 30, timeoutMs: 35_000,
      command: "git diff HEAD -- . ':(exclude).agents' | head -c 200000",
    }).catch(() => null);
    if (diff && diff.exitCode === 0 && diff.stdout && redactKnown(diff.stdout) !== diff.stdout) {
      return `retry_safety: a catalog secret value is present in the worktree diff of attempt ${attemptId}; ` +
        "remove the leaked value from the files and dispatch again manually — an automatic retry would carry it into new output";
    }
  }
  return null;
}

/** The defaults the task-level caps fall back to when the setting is unset or 0 (`writer.task_wall_clock_min`,
 * `writer.verify_max_passes`). */
export const TASK_WALL_CLOCK_MIN = 720;
export const VERIFY_MAX_PASSES = 10;

/** The task-level bounds of the retry loop (hive-audit H-05): its age against `writer.task_wall_clock_min` and its failed
 * verification gate evaluations against `writer.verify_max_passes`. Either cap ends the task with a reason instead of
 * another writer; a value of 0 or less means the caller's default. Per-session caps (SESSION_MAX_MS/turns) and the
 * attempt budget already exist; these two cap the task across sessions, restarts and chain handoffs. */
export function taskLimitStop(input: {
  db: LanePilotDatabase; runId: string; taskId: string;
  wallClockMin: number; verifyMaxPasses: number; now?: number;
}): string | null {
  const { db, runId, taskId, wallClockMin, verifyMaxPasses } = input;
  const now = input.now ?? Date.now();
  if (wallClockMin > 0) {
    const row = db.prepare("SELECT created_at FROM lane_pilot_task WHERE id=?").get(taskId) as { created_at: number } | undefined;
    const createdAt = typeof row?.created_at === "number" ? row.created_at : null;
    if (createdAt && now - createdAt > wallClockMin * 60_000) {
      const ageMin = Math.round((now - createdAt) / 60_000);
      return `task_wall_clock: ${taskId} is ${ageMin} min old, over the writer.task_wall_clock_min cap of ${wallClockMin}; ` +
        "split the work, raise the setting, or dispatch it again as a new task";
    }
  }
  if (verifyMaxPasses > 0) {
    const failed = (db.prepare(
      "SELECT COUNT(*) AS n FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? AND gate='verification' AND status IN ('failed','rejected')",
    ).get(runId, taskId) as { n: number }).n;
    if (failed >= verifyMaxPasses) {
      return `verify_passes_exhausted: ${taskId} failed or was rejected by ${failed} verification passes, at the writer.verify_max_passes cap of ${verifyMaxPasses}; ` +
        "fix the check or the contract, then dispatch again";
    }
  }
  return null;
}
