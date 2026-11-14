import type { ServerCore } from "../../contracts/server";
import type { FinishInput, Services } from "./finish-types";
import type { mountVerificationAttemptFinished } from "./verification";
import { countAttempts, countThreadTurns, firstAttemptAt, getAttempt, getRunSettingsScopes, loadProjectSettings, taskBasePath, transitionAttempt, failureFieldsOf } from "../../storage";
import { saveBlockedBy, type BlockedBy } from "../../runs/server";
import { relayFor } from "../../relay/server";
import { recordGateEvaluation } from "../../runs/server";
import { checkTimeoutSec } from "../check-timing";
import { shouldMergeAttemptWorktree } from "./spawn";
import { isLiveDecision } from "../live-folder";
import { askGuestsToCommit } from "./checkout-guests";
import { beginChecks, checksMoved } from "../../runs";
import { REPLAY_CHECK_FAILED } from "../../contracts/failure-class";
import { bookkeepingSetting } from "@lane-pilot/settings-catalog";
import { attemptMergeMessage, clearMergeIntent, recordMergeIntent } from "../../verification/server";
import { dependenciesAddedInDiff } from "../../forecast";
import { sendServiceMessage } from "../../relay/server";
import { sshKeysOpen } from "@lane-pilot/models";
import { taskSizeOf } from "../../tasks";
import { runOnHost } from "@lane-pilot/host-calls";
import { bestEffort } from "@lane-pilot/kit";
import { areaHasLiveWork, dirtyBase, DIRTY_BASE_WAIT_MS, MERGE_QUEUE_MS, mergeHolder } from "./merge-queue";

export interface FinishMergeDeps {
  ctx: ServerCore;
  services: Services;
  input: FinishInput;
  candidate: Awaited<ReturnType<Services["validateWriterResult"]>>;
  writerThreadId: string;
  review: "passed" | "not_required";
  checklist: Record<string, unknown>;
  verification: ReturnType<typeof mountVerificationAttemptFinished>;
  endedByStop: (reason: string, threadId?: string) => Record<string, unknown> | null;
  setEndMerge: (end: () => void) => void;
}

/** The accepted attempt's landing: persist the receipt, merge the worktree into the base checkout, keep the size record. */
export async function mergeAcceptedAttempt(deps: FinishMergeDeps): Promise<Record<string, unknown>> {
  const { ctx, services, input, candidate, writerThreadId, review, checklist, verification, endedByStop, setEndMerge } = deps;
  const { bb, db, host } = ctx;
      const receipt = await services.persistWriterAcceptance({
        config:input.config, task:input.task, runId:input.runId, taskId:input.taskId,
        attempt:countAttempts(db, input.runId, input.taskId), attemptId:input.attemptId,
        pmThreadId:input.pmThreadId, writerThreadId, output:candidate.output, verification:candidate.verification,
        emergencyFallback:input.emergencyFallback, review,
        warnings:candidate.warnings, turns:countThreadTurns(db, input.runId, input.taskId, input.writerThreadId),
      });
      // Work in the attempt's own worktree counts only once it is in the run's base checkout (main).
      // A conflict fails the attempt, so the retry redoes the task on a fresh worktree of the new main.
      const bound = getAttempt(db, input.attemptId);
      // The task's own checkout: the run's folder, or the repository inside it the task works in (its main is the merge target).
      const basePath = taskBasePath(db, input.runId, input.taskId);
      let integration: { status:string; commit:string|null; conflicts:string[]; rebased?:boolean } | null = null;
      if (bound?.workspace_path && basePath && shouldMergeAttemptWorktree(bound.workspace_path, basePath)) {
        const checkSettings = loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId));
        const replayChecks = input.task.verification.some((command) => !command.secrets?.length) ? {
          workspacePath:input.task.project_cwd,
          backend:(checkSettings["sandbox.backend"] as "auto" | "macos-seatbelt" | "linux-bubblewrap" | undefined) ?? "auto",
          ...(sshKeysOpen(checkSettings) ? { sshKeys:true } : {}),
          // A check with secrets cannot run on the host's replay (it has no Env Catalog); the post-merge check on main still runs it.
          // The same limit as the writer's own check: its history widens it (a replay at a raw 120 s killed checks the attempt had passed).
          commands:input.task.verification.filter((command) => !command.secrets?.length).slice(0, 20).map((command) => ({ command:command.command, cwd:command.cwd, timeoutSec:checkTimeoutSec(db, input.projectId, { command:command.command, cwd:command.cwd, root:input.task.project_cwd }, command.timeout_sec ?? 120) })),
        } : null;
        const replayMs = (replayChecks?.commands ?? []).reduce((sum, command) => sum + 2 * command.timeoutSec * 1000, 0);
        // The merge is acceptance too: the attempt stays «running» with its writer idle while it queues behind another task's
        // merge or replays its checks on a moved main, which the watcher reads like a check in flight (self-repair.ts).
        // Vampirism Fire 2026-10-25: vf-s7-cosmetics and vf-s7-cosmetics.2 were reported «stuck» 47–63 minutes, each in its
        // 7–18 minute replay of studio_test after green checks.
        const mergePool = `merge:${basePath}`;
        setEndMerge(beginChecks(input.writerThreadId, mergePool));
        const integrate = () => (checksMoved(mergePool), host.call("gitIntegrate", {
          requestedHostId:input.config.hostId, basePath, worktreePath:bound.workspace_path!,
          message:attemptMergeMessage(input.task, input.attemptId),
          // The merge removes the worktree and its branch at once (SMA ta_cleanup, docs/worktrees.md), also when the attempt ran in a BB
          // environment: the default lane-pilot-worktree provider's folder is Lane Pilot's own, and BB retires an environment whose folder is
          // gone (its threads are archived by the finished-attempt sweep). Until 0.1.561 only attempts without an environment were cleaned
          // here, so the default path left every accepted worktree to the hourly janitor. An area task keeps it for the area's next task
          // (the attempt-worktree sweep removes it after the sticky window).
          removeWorktree:!(input.task.area && areaHasLiveWork(db, input)),
          bookkeeping:bookkeepingSetting(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId))),
          ownsPaths:input.task.owns_paths.slice(0, 200),
          // When main moved and the attempt is replayed on it, the host runs these checks in the worktree before the merge.
          ...(replayChecks ? { replayChecks } : {}),
        }, { hostId:input.config.hostId, timeoutMs:180_000 + replayMs }).finally(() => checksMoved(mergePool)));
        // Written before the merge: a reply lost to a reload leaves main updated and this attempt «running»; the recovery
        // asks the machine's repository whether the work landed (merge-intent.ts). Dropped once the attempt's state caught up.
        await recordMergeIntent(bb.storage.kv as never, (hostId, cwd, command) => runOnHost(host, { hostId, cwd, command, timeoutSec: 30 }),
          { attemptId:input.attemptId, runId:input.runId, taskId:input.taskId, projectId:input.projectId, hostId:input.config.hostId,
            basePath, worktreePath:bound.workspace_path, message:attemptMergeMessage(input.task, input.attemptId) });
        const settleIntent = () => clearMergeIntent(bb.storage.kv as never, input.attemptId);
        // Another task merging into the same checkout is a queue, not a failure: wait for it and try again.
        let merged = await integrate();
        const queuedSince = Date.now();
        while (merged.status === "busy" && Date.now() - queuedSince < MERGE_QUEUE_MS && !ctx.isDisposed()) {
          await new Promise((wake) => setTimeout(wake, 20_000));
          merged = await integrate();
        }
        if (merged.status === "busy") {
          const blockedBy = mergeHolder(db, input.runId, merged.holder ?? null, queuedSince);
          const reason = `merge_queue_timeout: ${merged.reason ?? "another integration holds the base checkout"}`;
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"failed",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged,blockedBy}});
          await saveBlockedBy(bb.storage.kv, input.attemptId, blockedBy);
          // The PM is woken when the holder settles, or in 10 minutes, without the owner.
          await relayFor(ctx).remind({ projectId:input.projectId, threadId:input.pmThreadId, inMinutes:10, watchThreadId:blockedBy.holderThreadId,
            note:`Lane Pilot: task ${input.taskId} waited 15 minutes for merge: main checkout is held by ${blockedBy.holderTaskId ?? "another task"}. Writer's work is committed in its worktree; send the task again once the holder is free.` })
            .catch((cause) => ctx.log(`merge-block reminder failed: ${cause instanceof Error ? cause.message : String(cause)}`));
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          await settleIntent();
          return { status:"blocked", reason, blockedBy, attemptId:input.attemptId, writerThreadId };
        }
        // Someone's uncommitted edits in main block the merge: a redo would meet the same edits, so the finished work
        // waits for main to be clean and merges then (content-factory 2026-10-05: one task was rewritten three times).
        if (dirtyBase(merged)) {
          const files = merged.conflicts.join(", ");
          ctx.log(`writer ${input.taskId} waits for uncommitted edits in ${basePath} to be committed: ${files}`);
          // The chats that work in this folder are asked by name; the PM hears who was asked, or that nobody is known.
          const asked = await bestEffort(ctx.log, "writer guests commit ask", askGuestsToCommit(bb, basePath, merged.conflicts, input.taskId, input.pmThreadId), [] as string[]);
          void bestEffort(ctx.log, "writer guests notice", sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:writerThreadId,
            text:asked.length
              ? `Lane Pilot: task ${input.taskId} is ready, but main checkout ${basePath} has uncommitted changes in the same files: ${files}. Lane Pilot asked threads working in this folder to commit them: ${asked.map((thread) => `@thread:${thread}`).join(", ")}. The task will merge automatically once files are committed (waits up to 2 hours); no need to resend it.`
              : `Lane Pilot: task ${input.taskId} is ready, but main checkout ${basePath} has uncommitted changes in the same files: ${files}. Lane Pilot does not know whose chat it is: ask the owner to commit or put them away (or do it yourself if this chat made them). The task will merge automatically once the directory is clean (waits up to 2 hours); no need to resend it.` }), undefined);
          const since = Date.now();
          // Another task's merge may hold the checkout meanwhile: that is a wait too, never an acceptance without a merge.
          while ((dirtyBase(merged) || merged.status === "busy") && Date.now() - since < DIRTY_BASE_WAIT_MS && !ctx.isDisposed()) {
            await new Promise((wake) => setTimeout(wake, 60_000));
            merged = await integrate();
          }
          if (dirtyBase(merged) || merged.status === "busy") {
            const reason = `merge_blocked: base checkout has uncommitted changes in files this task changes: ${merged.conflicts.join(", ") || files}`;
            const blockedBy:BlockedBy = { kind:"human", holderTaskId:null, holderThreadId:null, holderAttemptId:null,
              since:new Date(since).toISOString(), retryAfterSec:600, detail:merged.conflicts.join(", ") };
            await saveBlockedBy(bb.storage.kv, input.attemptId, blockedBy);
            recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"failed",
              attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged,blockedBy}});
            transitionAttempt(db, input.attemptId, "blocked", { reason });
            await settleIntent();
            return { status:"blocked", reason, blockedBy, attemptId:input.attemptId, writerThreadId };
          }
        }
        if (merged.status === "conflict" || merged.status === "failed") {
          // The task's checks went red on the attempt replayed on the new main: a free redo by the same writer, with their output.
          const replayRed = merged.status === "conflict" && Boolean(merged.reason?.startsWith(REPLAY_CHECK_FAILED));
          const reason = merged.status === "conflict"
            ? `merge_conflict: ${merged.reason?.startsWith("base checkout") ? merged.reason : "main changed since this attempt started"}: ${replayRed ? merged.reason : merged.conflicts.join(", ")}`
            : `merge_failed: ${merged.reason ?? "unknown"}`;
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged}});
          const stopped = endedByStop(reason, writerThreadId);
          if (!stopped) transitionAttempt(db, input.attemptId, "validation_failed", { reason, ...failureFieldsOf(merged) });
          await settleIntent();
          if (stopped) return stopped;
          return { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:replayRed && merged.checks?.length ? merged.checks : candidate.verification,
            attemptId:input.attemptId, writerThreadId };
        }
        integration = { status:merged.status, commit:merged.commit, conflicts:[], ...(merged.rebased ? { rebased:true } : {}) };
        // The base, the merge commit and the files it changed (deletions included) go on the attempt's record (SMA wall 4).
        // The landing record (SMA k_lib_landing) rides the same row: the count of checks that were green when the merge went in.
        services.rollback?.noteMerge(input.attemptId, merged, (candidate.verification ?? []).filter((check) => check.exitCode === 0).length);
        if (merged.status === "merged") {
          // The landed reactions run now, fire-and-forget as before: the merge intent is cleared below, and a
          // reload between merge and this launch leaves the intent for recovery to redo.
          verification.landed(input, basePath, merged.commit, candidate.produced ?? [], false, bound.workspace_path,
            (candidate.verification ?? []).filter((check) => check.exitCode === 0).map((check) => check.command));
        }
      } else if (bound && basePath && isLiveDecision(bound.workspace_decision)) {
        // A folder with no repository has no merge: the accepted task is in place, and the gate runs there once the queue drains.
        verification.landed(input, basePath, null, candidate.produced ?? [], true, null, undefined);
      }
      // #29 task-size metric: what this accepted task cost (files, diff lines, minutes, attempts) rides the receipt;
      // the project's median over these rows is what plan warnings measure new slices against.
      // SMA k_lib_footprint: the same merge diff names the dependency manifests it touched — the packages it added
      // are scored against the forecast's declared ones.
      let sizeLines = 0;
      let dependenciesAdded: string[] = [];
      if (integration?.commit) {
        const stat = await bestEffort(ctx.log, "writer task size probe", runOnHost(host, { hostId:input.config.hostId, cwd:basePath!, command:`git diff --shortstat ${integration.commit}^ ${integration.commit}`, timeoutSec:15, timeoutMs:15_000 }), null);
        if (stat && stat.exitCode === 0) for (const m of stat.stdout.matchAll(/(\d+) insertions?|(\d+) deletions?/g)) sizeLines += Number(m[1] ?? m[2] ?? 0);
        const depDiff = await bestEffort(ctx.log, "writer task dependency probe", runOnHost(host, { hostId:input.config.hostId, cwd:basePath!, command:`git diff ${integration.commit}^ ${integration.commit} -- package.json requirements.txt requirements-dev.txt pyproject.toml`, timeoutSec:15, timeoutMs:15_000 }), null);
        if (depDiff && depDiff.exitCode === 0) dependenciesAdded = dependenciesAddedInDiff(depDiff.stdout);
      }
      const firstAttempt = firstAttemptAt(db, input.taskId);
      const size = taskSizeOf({ files:(candidate.produced ?? []).length, lines:sizeLines, createdAt:firstAttempt, finishedAt:Date.now(), attempts:countAttempts(db,input.runId,input.taskId) });
      recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"passed",
        attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{acceptanceReceiptPersisted:true,integration,size,execution_checklist:checklist}});
      transitionAttempt(db, input.attemptId, "accepted");
      if (integration) await clearMergeIntent(bb.storage.kv as never, input.attemptId);
      return { ...receipt, verification:candidate.verification, produced:candidate.produced, size, dependencies:dependenciesAdded };
}
