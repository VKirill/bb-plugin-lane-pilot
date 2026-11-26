import { countAttempts, getAttempt, getRun, getTask, getTaskPlan, transitionAttempt } from "../../../storage";
import { closeWriterStages, recordGateEvaluation } from "../../../runs/server";
import type { ServerCore } from "../../../contracts/server";
import { isFinalAttemptState } from "../../../contracts";
import { bestEffort } from "@lane-pilot/kit";
import { runOnHost } from "@lane-pilot/host-calls";
import type { WorkflowEngineApi, WriterStateApi } from "../../../platform/server";
import {
  MERGE_INTENT_PREFIX,
  attemptMergeMessage,
  attemptTrailer,
  mergeIntentKey,
  type MergeIntent,
  type MergeVerdict,
  type RunOnHost,
} from "../../models/merge-intent";
import { clearMergeIntent, recordMergeIntent, type MergeIntentKv } from "../repositories/merge-intent-repository";

export {
  MERGE_INTENT_PREFIX,
  attemptMergeMessage,
  attemptTrailer,
  clearMergeIntent,
  mergeIntentKey,
  recordMergeIntent,
};
export type { MergeIntent, MergeVerdict, RunOnHost };

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  startAfterAcceptance: WorkflowEngineApi["startAfterAcceptance"];
}

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/**
 * Whether the attempt's work is in the base checkout now, asked of git on the project's machine. Three witnesses, any
 * one is enough, each naming the exact commit that proves it: the attempt's commit made before the merge, the
 * worktree's present tip when it is clean (a rebase or the commit of the writer's loose edits made it), and the merge
 * commit carrying the attempt's own trailer among the commits main took since the intent. The first two count only a
 * commit that was not already in main when the intent was written: a worktree is made from main's head of that day, so
 * its fork point (the HEAD of an attempt with only loose edits, or of a clean worktree) is an ancestor of a main that
 * moved on whether or not the merge ever ran. `unknown` when the machine did not answer.
 */
export async function mergeLanded(intent: MergeIntent, run: RunOnHost, log: (message: string) => void = console.warn): Promise<MergeVerdict> {
  const ask = (cwd: string, command: string) =>
    bestEffort(log, `merge intent ask ${intent.attemptId} ${command.slice(0, 80)}`, run(intent.hostId, cwd, command), { exitCode: -1, stdout: "", stderr: "unreachable" });
  const head = await ask(intent.basePath, "git rev-parse HEAD");
  if (head.exitCode !== 0 || !head.stdout.trim()) return { unknown: true };
  const main = head.stdout.trim();
  const ancestor = async (sha: string, of?: string) => (await ask(intent.basePath, `git merge-base --is-ancestor ${quote(sha)} ${of ? quote(of) : "HEAD"}`)).exitCode === 0;
  // A commit of the attempt itself: in main now, and not in main's history as it stood when the intent was written.
  // Without that head (the machine did not answer then) no commit can be told from the fork point, only the trailer proves it.
  const attemptCommitInMain = async (sha: string) =>
    Boolean(intent.baseHead) && sha !== intent.baseHead && !(await ancestor(sha, intent.baseHead!)) && (await ancestor(sha));
  if (intent.sha && (await attemptCommitInMain(intent.sha))) return { landed: true, how: `attempt commit ${intent.sha.slice(0, 12)} is in main`, commit: main };
  const tip = await ask(intent.worktreePath, "git status --porcelain --untracked-files=all && git rev-parse HEAD");
  if (tip.exitCode === 0) {
    const lines = tip.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    // Clean worktree only: loose edits not committed yet say nothing about the merge, whatever the tip is.
    if (lines.length === 1 && (await attemptCommitInMain(lines[0]!))) return { landed: true, how: `worktree tip ${lines[0]!.slice(0, 12)} is in main`, commit: main };
  }
  // The merge commit carrying the attempt's trailer among what main took since the intent: after main's head at that time, or by the clock when
  // the machine could not tell the head.
  const since = intent.baseHead ? ((await ancestor(intent.baseHead)) ? quote(`${intent.baseHead}..HEAD`) : null) : `--since=@${Math.floor(intent.at / 1000)} HEAD`;
  if (since) {
    // The trailer is matched line by line: a fixed-string grep alone takes `a10` for `a1`.
    const found = await ask(intent.basePath, `git log -n 50 --format=%H%x1f%B%x1e --fixed-strings --grep=${quote(attemptTrailer(intent.attemptId))} ${since}`);
    if (found.exitCode === 0) {
      for (const entry of found.stdout.split("\x1e")) {
        const [commit, body = ""] = entry.split("\x1f");
        if (commit?.trim() && body.split("\n").some((line) => line.trim() === attemptTrailer(intent.attemptId))) {
          return { landed: true, how: `merge commit ${commit.trim().slice(0, 12)} is in main`, commit: commit.trim() };
        }
      }
    }
  }
  return { landed: false };
}

/**
 * Settles every intent a run left behind. An attempt not yet ended whose work is in main is accepted with a receipt
 * (a redo would find no worktree, or conflict with itself); one whose work is not in main keeps the intent while a loop
 * of this process still works on it, and loses it otherwise (the ordinary recovery redoes the task). An attempt already
 * accepted or canceled only loses the intent. Never throws for one intent: the rest still settle.
 */
export function createMergeIntentRecovery(ctx: ServerCore, services: Services) {
  const { bb, db, host, refreshRun } = ctx;
  const kv = bb.storage.kv as unknown as MergeIntentKv;
  const run: RunOnHost = (hostId, cwd, command) =>
    runOnHost(host, { hostId, cwd, command, timeoutSec: 30 }).then((ran) => ({ exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }));

  async function recoverMergeIntents(options: { now?: number; graceMs?: number } = {}): Promise<string[]> {
    const accepted: string[] = [];
    const now = options.now ?? Date.now();
    for (const key of await kv.list(MERGE_INTENT_PREFIX)) {
      let intent: MergeIntent | null;
      try {
        intent = (await kv.get(key)) as MergeIntent | null;
      } catch (cause) {
        bb.log.warn(`merge intent ${key} unreadable, skipped this pass: ${cause instanceof Error ? cause.message : String(cause)}`);
        continue;
      }
      if (!intent || typeof intent !== "object" || !intent.attemptId) {
        await bestEffort(bb.log, `merge intent delete ${key}`, kv.delete(key), undefined);
        continue;
      }
      try {
        const attempt = getAttempt(db, intent.attemptId);
        if (!attempt || isFinalAttemptState(attempt.state)) {
          await clearMergeIntent(kv, intent.attemptId);
          continue;
        }
        // A loop of this process is on it: it clears the intent itself, whatever the merge says.
        if (services.activeWriterTasks.has(`${intent.runId}:${intent.taskId}`)) continue;
        // A merge cut off a moment ago may still be running on the machine; the next pass decides.
        if (now - intent.at < (options.graceMs ?? 0)) continue;
        const verdict = await mergeLanded(intent, run, (message) => bb.log.warn(message));
        if ("unknown" in verdict) continue;
        if (!verdict.landed) {
          await clearMergeIntent(kv, intent.attemptId);
          continue;
        }
        const stored = getTask(db, intent.taskId);
        const receipt = {
          recoveredFromMergeIntent: true,
          integration: { status: "merged", commit: verdict.commit, conflicts: [] as string[] },
          evidence: verdict.how,
          previousState: attempt.state,
        };
        recordGateEvaluation(db, {
          projectId: intent.projectId,
          runId: intent.runId,
          taskId: intent.taskId,
          gate: "accept",
          status: "passed",
          attempt: countAttempts(db, intent.runId, intent.taskId),
          input: JSON.stringify(stored?.contract ?? {}),
          summary: receipt,
        });
        transitionAttempt(db, intent.attemptId, "accepted", { reason: `merge landed before its reply was lost (${verdict.how})` });
        closeWriterStages(db, {
          runId: intent.runId,
          taskId: intent.taskId,
          plan: getTaskPlan(db, intent.taskId) ?? "",
          terminal: "passed",
          attempt: countAttempts(db, intent.runId, intent.taskId),
          threadId: attempt.thread_id,
          result: receipt,
        });
        refreshRun(intent.runId);
        const pmThreadId = getRun(db, intent.runId)?.pm_thread_id ?? "";
        services.startAfterAcceptance(intent.projectId, intent.runId, intent.taskId, pmThreadId);
        await clearMergeIntent(kv, intent.attemptId);
        accepted.push(intent.taskId);
        // The PM is not told (a note that needs no action wakes a chat for nothing): the task's row is accepted, which is what it sees.
        bb.log.info(`Lane Pilot accepted ${intent.taskId} from its merge intent: ${verdict.how}`);
      } catch (cause) {
        bb.log.warn(`Lane Pilot merge intent ${intent.attemptId} not settled: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return accepted;
  }

  return { recoverMergeIntents };
}
