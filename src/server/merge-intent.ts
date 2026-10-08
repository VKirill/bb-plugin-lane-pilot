import { countAttempts, getAttempt, getRun, getTask, getTaskPlan, transitionAttempt } from "../database";
import { closeWriterStages, recordGateEvaluation } from "./stage-records";
import type { ServerCore } from "./core";
import type { Services } from "./services";
import { sendServiceMessage } from "../rooms/relay/server/service-message";
import { runOnHost } from "@lane-pilot/host-calls";

/**
 * The delivery record of a merge (Firstmate's delivery registry, the write-ahead log of a database). The merge, the
 * removal of the attempt's worktree and the `branch -D` run on the project's machine and the database learns of them
 * afterwards: a reply lost to a reload left main updated and the attempt «running» for good, and its retry found no
 * worktree. The intent is written before `gitIntegrate`, dropped once the attempt's state has caught up, and on
 * recovery git itself says whether the work landed.
 */
export const MERGE_INTENT_PREFIX = "merge-intent:";
export const mergeIntentKey = (attemptId:string) => `${MERGE_INTENT_PREFIX}${attemptId}`;

/** The trailer that names an attempt in the commits it makes: two attempts of one task share a title, so the title proves nothing. */
export const attemptTrailer = (attemptId:string) => `Lane-Pilot-Attempt: ${attemptId}`;

/** The message gitIntegrate commits and merges with (500 characters at most): the task's title line and the attempt's trailer. */
export const attemptMergeMessage = (task:{ id:string; title:string }, attemptId:string) =>
  `${`${task.id}: ${task.title}`.replace(/\s+/g, " ").slice(0, 400)}\n\n${attemptTrailer(attemptId)}`;

export type MergeIntent = {
  attemptId:string; runId:string; taskId:string; projectId:string; hostId:string;
  /** The run's base checkout (main) and the attempt's own worktree. */
  basePath:string; worktreePath:string;
  /** The attempt's branch and HEAD, and main's HEAD, when the intent was written; null when the machine did not answer. */
  branch:string | null; sha:string | null; baseHead:string | null;
  /** The commit message gitIntegrate merges with (`attemptMergeMessage`): the merge commit carries it, trailer included. */
  message:string;
  at:number;
};

export type RunOnHost = (hostId:string, cwd:string, command:string) => Promise<{ exitCode:number; stdout:string; stderr:string }>;
type Kv = { get(key:string):Promise<unknown>; set(key:string, value:never):Promise<unknown>; delete(key:string):Promise<unknown>; list(prefix?:string):Promise<string[]> };

const quote = (text:string) => `'${text.replace(/'/g, "'\\''")}'`;

/** Writes the intent. A machine that cannot tell the heads still gets one (the attempt's trailer in the merge commit identifies the merge); a KV failure never blocks the merge. */
export async function recordMergeIntent(kv:Kv, run:RunOnHost, input:Omit<MergeIntent, "branch" | "sha" | "baseHead" | "at">):Promise<void> {
  const heads = await run(input.hostId, input.basePath,
    `git rev-parse HEAD; git -C ${quote(input.worktreePath)} rev-parse HEAD; git -C ${quote(input.worktreePath)} rev-parse --abbrev-ref HEAD`).catch(() => null);
  const [baseHead, sha, branch] = heads && heads.exitCode === 0 ? heads.stdout.split("\n").map((line) => line.trim()) : [];
  const intent:MergeIntent = { ...input, baseHead:baseHead || null, sha:sha || null, branch:branch || null, at:Date.now() };
  await kv.set(mergeIntentKey(input.attemptId), intent as never).catch(() => undefined);
}

export async function clearMergeIntent(kv:Pick<Kv, "delete">, attemptId:string):Promise<void> {
  await kv.delete(mergeIntentKey(attemptId)).catch(() => undefined);
}

export type MergeVerdict = { landed:true; how:string; commit:string | null } | { landed:false } | { unknown:true };

/**
 * Whether the attempt's work is in the base checkout now, asked of git on the project's machine. Three witnesses, any
 * one is enough, each naming the exact commit that proves it: the attempt's commit made before the merge, the
 * worktree's present tip when it is clean (a rebase or the commit of the writer's loose edits made it), and the merge
 * commit carrying the attempt's own trailer among the commits main took since the intent. The first two count only a
 * commit that was not already in main when the intent was written: a worktree is made from main's head of that day, so
 * its fork point (the HEAD of an attempt with only loose edits, or of a clean worktree) is an ancestor of a main that
 * moved on whether or not the merge ever ran. `unknown` when the machine did not answer.
 */
export async function mergeLanded(intent:MergeIntent, run:RunOnHost):Promise<MergeVerdict> {
  const ask = (cwd:string, command:string) => run(intent.hostId, cwd, command).catch(() => ({ exitCode:-1, stdout:"", stderr:"unreachable" }));
  const head = await ask(intent.basePath, "git rev-parse HEAD");
  if (head.exitCode !== 0 || !head.stdout.trim()) return { unknown:true };
  const main = head.stdout.trim();
  const ancestor = async (sha:string, of?:string) => (await ask(intent.basePath, `git merge-base --is-ancestor ${quote(sha)} ${of ? quote(of) : "HEAD"}`)).exitCode === 0;
  // A commit of the attempt itself: in main now, and not in main's history as it stood when the intent was written.
  // Without that head (the machine did not answer then) no commit can be told from the fork point, only the trailer proves it.
  const attemptCommitInMain = async (sha:string) =>
    Boolean(intent.baseHead) && sha !== intent.baseHead && !await ancestor(sha, intent.baseHead!) && await ancestor(sha);
  if (intent.sha && await attemptCommitInMain(intent.sha)) return { landed:true, how:`attempt commit ${intent.sha.slice(0, 12)} is in main`, commit:main };
  const tip = await ask(intent.worktreePath, "git status --porcelain --untracked-files=all && git rev-parse HEAD");
  if (tip.exitCode === 0) {
    const lines = tip.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    // Clean worktree only: loose edits not committed yet say nothing about the merge, whatever the tip is.
    if (lines.length === 1 && await attemptCommitInMain(lines[0]!)) return { landed:true, how:`worktree tip ${lines[0]!.slice(0, 12)} is in main`, commit:main };
  }
  // The merge commit carrying the attempt's trailer among what main took since the intent: after main's head at that time, or by the clock when
  // the machine could not tell the head.
  const since = intent.baseHead ? (await ancestor(intent.baseHead) ? quote(`${intent.baseHead}..HEAD`) : null) : `--since=@${Math.floor(intent.at / 1000)} HEAD`;
  if (since) {
    // The trailer is matched line by line: a fixed-string grep alone takes `a10` for `a1`.
    const found = await ask(intent.basePath, `git log -n 50 --format=%H%x1f%B%x1e --fixed-strings --grep=${quote(attemptTrailer(intent.attemptId))} ${since}`);
    if (found.exitCode === 0) {
      for (const entry of found.stdout.split("\x1e")) {
        const [commit, body = ""] = entry.split("\x1f");
        if (commit?.trim() && body.split("\n").some((line) => line.trim() === attemptTrailer(intent.attemptId))) {
          return { landed:true, how:`merge commit ${commit.trim().slice(0, 12)} is in main`, commit:commit.trim() };
        }
      }
    }
  }
  return { landed:false };
}

/**
 * Settles every intent a run left behind. An attempt not yet ended whose work is in main is accepted with a receipt
 * (a redo would find no worktree, or conflict with itself); one whose work is not in main keeps the intent while a loop
 * of this process still works on it, and loses it otherwise (the ordinary recovery redoes the task). An attempt already
 * accepted or canceled only loses the intent. Never throws for one intent: the rest still settle.
 */
export function createMergeIntentRecovery(ctx:ServerCore, services:Services) {
  const { bb, db, host, refreshRun } = ctx;
  const kv = bb.storage.kv as unknown as Kv;
  const run:RunOnHost = (hostId, cwd, command) => runOnHost(host, { hostId, cwd, command, timeoutSec: 30 })
    .then((ran) => ({ exitCode:ran.exitCode, stdout:ran.stdout, stderr:ran.stderr }));

  async function recoverMergeIntents(options:{ now?:number; graceMs?:number } = {}):Promise<string[]> {
    const accepted:string[] = [];
    const now = options.now ?? Date.now();
    for (const key of await kv.list(MERGE_INTENT_PREFIX).catch(() => [] as string[])) {
      const intent = await kv.get(key).catch(() => null) as MergeIntent | null;
      if (!intent || typeof intent !== "object" || !intent.attemptId) { await kv.delete(key).catch(() => undefined); continue; }
      try {
        const attempt = getAttempt(db, intent.attemptId);
        if (!attempt || ["accepted", "canceled"].includes(attempt.state)) { await clearMergeIntent(kv, intent.attemptId); continue; }
        // A loop of this process is on it: it clears the intent itself, whatever the merge says.
        if (services.activeWriterTasks.has(`${intent.runId}:${intent.taskId}`)) continue;
        // A merge cut off a moment ago may still be running on the machine; the next pass decides.
        if (now - intent.at < (options.graceMs ?? 0)) continue;
        const verdict = await mergeLanded(intent, run);
        if ("unknown" in verdict) continue;
        if (!verdict.landed) { await clearMergeIntent(kv, intent.attemptId); continue; }
        const stored = getTask(db, intent.taskId);
        const receipt = { recoveredFromMergeIntent:true, integration:{ status:"merged", commit:verdict.commit, conflicts:[] as string[] }, evidence:verdict.how, previousState:attempt.state };
        recordGateEvaluation(db, { projectId:intent.projectId, runId:intent.runId, taskId:intent.taskId, gate:"accept", status:"passed",
          attempt:countAttempts(db, intent.runId, intent.taskId), input:JSON.stringify(stored?.contract ?? {}), summary:receipt });
        transitionAttempt(db, intent.attemptId, "accepted", { reason:`merge landed before its reply was lost (${verdict.how})` });
        closeWriterStages(db, { runId:intent.runId, taskId:intent.taskId, plan:getTaskPlan(db, intent.taskId) ?? "", terminal:"passed",
          attempt:countAttempts(db, intent.runId, intent.taskId), threadId:attempt.thread_id, result:receipt });
        refreshRun(intent.runId);
        const pmThreadId = getRun(db, intent.runId)?.pm_thread_id ?? "";
        services.maintainMemoryAfterAcceptance(intent.projectId, intent.runId, intent.taskId, pmThreadId);
        services.maintainProjectLifeAfterAcceptance(intent.projectId, intent.runId, intent.taskId, pmThreadId);
        await clearMergeIntent(kv, intent.attemptId);
        accepted.push(intent.taskId);
        bb.log.info(`Lane Pilot accepted ${intent.taskId} from its merge intent: ${verdict.how}`);
        if (pmThreadId) {
          void sendServiceMessage(bb, { threadId:pmThreadId, senderThreadId:attempt.thread_id,
            text:`Lane Pilot (no action needed): ${intent.taskId} was merged into main but its result was lost in a plugin reload (${verdict.how}); it is accepted, do not redispatch it.` })
            .catch(() => undefined);
        }
      } catch (cause) {
        bb.log.warn(`Lane Pilot merge intent ${intent.attemptId} not settled: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return accepted;
  }

  return { recoverMergeIntents };
}
