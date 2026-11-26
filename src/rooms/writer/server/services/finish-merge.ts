import type { ServerCore } from "../../../contracts/server";
import type { FinishInput, Services } from "./finish-types";
import type { mountVerificationAttemptFinished } from "./verification";
import { countAttempts, countThreadTurns, firstAttemptAt, getAttempt, getRunSettingsScopes, loadProjectSettings, taskBasePath, transitionAttempt, failureFieldsOf } from "../../../storage";
import { saveBlockedBy, type BlockedBy } from "../../../runs/server";
import { relayFor } from "../../../relay/server";
import { recordGateEvaluation } from "../../../runs/server";
import { checkTimeoutSec } from "./check-timing";
import { shouldMergeAttemptWorktree } from "./spawn";
import { isLiveDecision } from "../../models/live-folder";
import { askGuestsToCommit } from "./checkout-guests";
import { beginChecks, checksMoved } from "../../../runs";
import { REPLAY_CHECK_FAILED } from "../../../contracts/failure-class";
import { bookkeepingSetting } from "@lane-pilot/settings-catalog";
import { attemptMergeMessage, clearMergeIntent, recordMergeIntent } from "../../../verification/server";
import { dependenciesAddedInDiff } from "../../../forecast";
import { sendServiceMessage } from "../../../relay/server";
import { sshKeysOpen } from "@lane-pilot/models";
import { taskSizeOf } from "../../../tasks";
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

export type MergeWaitState = {
  busySince?: number;
  dirtySince?: number;
  askedDirty?: boolean;
};

export type MergeStepOutcome =
  | { kind: "done"; result: Record<string, unknown> }
  | { kind: "wait"; waitKind: "busy" | "dirty"; waitUntil: number; durationSec: number; state: MergeWaitState; reason: string };

/**
 * Single non-blocking merge pass: persists acceptance receipt (if needed), attempts one `gitIntegrate`, and
 * returns either a finished outcome OR `{ kind: "wait", waitUntil, durationSec }` so the workflow graph waits
 * via a durable `builtin:wait` deadline instead of sleeping in a polling loop.
 */
export async function integrateAttemptOnce(deps: FinishMergeDeps, state: MergeWaitState = {}, now = Date.now()): Promise<MergeStepOutcome> {
  const { ctx, services, input, candidate, writerThreadId, review, checklist, verification, endedByStop, setEndMerge } = deps;
  const { bb, db, host } = ctx;
      let receipt: Record<string, unknown>;
      try {
        receipt = await services.persistWriterAcceptance({
          config:input.config, task:input.task, runId:input.runId, taskId:input.taskId,
          attempt:countAttempts(db, input.runId, input.taskId), attemptId:input.attemptId,
          pmThreadId:input.pmThreadId, writerThreadId, output:candidate.output, verification:candidate.verification,
          emergencyFallback:input.emergencyFallback, review,
          warnings:candidate.warnings, turns:countThreadTurns(db, input.runId, input.taskId, input.writerThreadId),
          produced:candidate.produced,
        });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        if (!reason.startsWith("acceptance_refused:")) throw cause;
        recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
          attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{writerStatus:"acceptance_refused",reason}});
        const stopped = endedByStop(reason, writerThreadId);
        if (stopped) return { kind: "done", result: stopped };
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        return { kind: "done", result: { status:"blocked", reason, attemptId:input.attemptId, writerThreadId } };
      }
      const bound = getAttempt(db, input.attemptId);
      const basePath = taskBasePath(db, input.runId, input.taskId);
      let integration: { status:string; commit:string|null; conflicts:string[]; rebased?:boolean } | null = null;
      if (bound?.workspace_path && basePath && shouldMergeAttemptWorktree(bound.workspace_path, basePath)) {
        const checkSettings = loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId));
        const replayChecks = input.task.verification.some((command) => !command.secrets?.length) ? {
          workspacePath:input.task.project_cwd,
          backend:(checkSettings["sandbox.backend"] as "auto" | "macos-seatbelt" | "linux-bubblewrap" | undefined) ?? "auto",
          ...(sshKeysOpen(checkSettings) ? { sshKeys:true } : {}),
          commands:input.task.verification.filter((command) => !command.secrets?.length).slice(0, 20).map((command) => ({ command:command.command, cwd:command.cwd, timeoutSec:checkTimeoutSec(db, input.projectId, { command:command.command, cwd:command.cwd, root:input.task.project_cwd }, command.timeout_sec ?? 120) })),
        } : null;
        const replayMs = (replayChecks?.commands ?? []).reduce((sum, command) => sum + 2 * command.timeoutSec * 1000, 0);
        const mergePool = `merge:${basePath}`;
        setEndMerge(beginChecks(input.writerThreadId, mergePool));
        await recordMergeIntent(bb.storage.kv as never, (hostId, cwd, command) => runOnHost(host, { hostId, cwd, command, timeoutSec: 30 }),
          { attemptId:input.attemptId, runId:input.runId, taskId:input.taskId, projectId:input.projectId, hostId:input.config.hostId,
            basePath, worktreePath:bound.workspace_path, message:attemptMergeMessage(input.task, input.attemptId) });
        const settleIntent = () => clearMergeIntent(bb.storage.kv as never, input.attemptId);
        const merged = await (checksMoved(mergePool), host.call("gitIntegrate", {
          requestedHostId:input.config.hostId, basePath, worktreePath:bound.workspace_path!,
          message:attemptMergeMessage(input.task, input.attemptId),
          removeWorktree:!(input.task.area && areaHasLiveWork(db, input)),
          bookkeeping:bookkeepingSetting(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId))),
          ownsPaths:input.task.owns_paths.slice(0, 200),
          ...(replayChecks ? { replayChecks } : {}),
        }, { hostId:input.config.hostId, timeoutMs:180_000 + replayMs }).finally(() => checksMoved(mergePool)));
        if (merged.status === "busy") {
          const busySince = state.busySince ?? now;
          const dirtyElapsed = state.dirtySince !== undefined ? now - state.dirtySince : 0;
          const withinDirty = state.dirtySince !== undefined && dirtyElapsed < DIRTY_BASE_WAIT_MS;
          if ((state.dirtySince === undefined && now - busySince < MERGE_QUEUE_MS) || withinDirty) {
            const ceil = state.dirtySince !== undefined ? state.dirtySince + DIRTY_BASE_WAIT_MS : busySince + MERGE_QUEUE_MS;
            const stepMs = state.dirtySince !== undefined ? 60_000 : 20_000;
            const waitUntil = Math.min(ceil, now + stepMs);
            return { kind: "wait", waitKind: state.dirtySince !== undefined ? "dirty" : "busy", waitUntil, durationSec: Math.max(1, Math.ceil((waitUntil - now) / 1_000)), state: { ...state, busySince }, reason: merged.reason ?? "another integration holds the base checkout" };
          }
          const blockedBy = mergeHolder(db, input.runId, merged.holder ?? null, busySince);
          const reason = `merge_queue_timeout: ${merged.reason ?? "another integration holds the base checkout"}`;
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"failed",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged,blockedBy}});
          await saveBlockedBy(bb.storage.kv, input.attemptId, blockedBy);
          await relayFor(ctx).remind({ projectId:input.projectId, threadId:input.pmThreadId, inMinutes:10, watchThreadId:blockedBy.holderThreadId,
            note:`Lane Pilot: task ${input.taskId} waited 15 minutes for merge: main checkout is held by ${blockedBy.holderTaskId ?? "another task"}. Writer's work is committed in its worktree; send the task again once the holder is free.` })
            .catch((cause) => ctx.log(`merge-block reminder failed: ${cause instanceof Error ? cause.message : String(cause)}`));
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          await settleIntent();
          return { kind: "done", result: { status:"blocked", reason, blockedBy, attemptId:input.attemptId, writerThreadId } };
        }
        if (dirtyBase(merged)) {
          const files = merged.conflicts.join(", ");
          const dirtySince = state.dirtySince ?? now;
          if (!state.askedDirty) {
            ctx.log(`writer ${input.taskId} waits for uncommitted edits in ${basePath} to be committed: ${files}`);
            const asked = await bestEffort(ctx.log, "writer guests commit ask", askGuestsToCommit(bb, basePath, merged.conflicts, input.taskId, input.pmThreadId), [] as string[]);
            if (!asked.length) void bestEffort(ctx.log, "writer guests notice", sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:writerThreadId,
              text:`Lane Pilot: task ${input.taskId} is ready, but main checkout ${basePath} has uncommitted changes in the same files: ${files}. Lane Pilot does not know whose chat it is: ask the owner to commit or put them away (or do it yourself if this chat made them). The task will merge automatically once the directory is clean (waits up to 2 hours); no need to resend it.` }), undefined);
          }
          if (now - dirtySince < DIRTY_BASE_WAIT_MS) {
            const waitUntil = Math.min(dirtySince + DIRTY_BASE_WAIT_MS, now + 60_000);
            return { kind: "wait", waitKind: "dirty", waitUntil, durationSec: Math.max(1, Math.ceil((waitUntil - now) / 1_000)), state: { ...state, dirtySince, askedDirty: true }, reason: `dirty base checkout: ${files}` };
          }
          const reason = `merge_blocked: base checkout has uncommitted changes in files this task changes: ${merged.conflicts.join(", ") || files}`;
          const blockedBy:BlockedBy = { kind:"human", holderTaskId:null, holderThreadId:null, holderAttemptId:null,
            since:new Date(dirtySince).toISOString(), retryAfterSec:600, detail:merged.conflicts.join(", ") };
          await saveBlockedBy(bb.storage.kv, input.attemptId, blockedBy);
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"failed",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged,blockedBy}});
          transitionAttempt(db, input.attemptId, "blocked", { reason });
          await settleIntent();
          return { kind: "done", result: { status:"blocked", reason, blockedBy, attemptId:input.attemptId, writerThreadId } };
        }
        if (merged.status === "conflict" || merged.status === "failed") {
          const replayRed = merged.status === "conflict" && Boolean(merged.reason?.startsWith(REPLAY_CHECK_FAILED));
          const reason = merged.status === "conflict"
            ? `merge_conflict: ${merged.reason?.startsWith("base checkout") ? merged.reason : "main changed since this attempt started"}: ${replayRed ? merged.reason : merged.conflicts.join(", ")}`
            : `merge_failed: ${merged.reason ?? "unknown"}`;
          recordGateEvaluation(db,{attemptId:input.attemptId,projectId:input.projectId,runId:input.runId,taskId:input.taskId,gate:"accept",status:"rejected",
            attempt:countAttempts(db,input.runId,input.taskId),input:JSON.stringify(input.task),summary:{integration:merged}});
          const stopped = endedByStop(reason, writerThreadId);
          if (!stopped) transitionAttempt(db, input.attemptId, "validation_failed", { reason, ...failureFieldsOf(merged) });
          await settleIntent();
          if (stopped) return { kind: "done", result: stopped };
          return { kind: "done", result: { status:"validation_failed", reason, output:candidate.output, produced:candidate.produced, verification:replayRed && merged.checks?.length ? merged.checks : candidate.verification,
            attemptId:input.attemptId, writerThreadId } };
        }
        integration = { status:merged.status, commit:merged.commit, conflicts:[], ...(merged.rebased ? { rebased:true } : {}) };
        services.rollback?.noteMerge(input.attemptId, merged, (candidate.verification ?? []).filter((check) => check.exitCode === 0).length);
        if (merged.status === "merged") {
          verification.landed(input, basePath, merged.commit, candidate.produced ?? [], false, bound.workspace_path,
            (candidate.verification ?? []).filter((check) => check.exitCode === 0).map((check) => check.command));
        }
      } else if (bound && basePath && isLiveDecision(bound.workspace_decision)) {
        verification.landed(input, basePath, null, candidate.produced ?? [], true, null, undefined);
      }
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
      return { kind: "done", result: { ...receipt, verification:candidate.verification, produced:candidate.produced, size, dependencies:dependenciesAdded } };
}

/** The accepted attempt's landing: persist the receipt, merge the worktree into the base checkout, keep the size record. */
export async function mergeAcceptedAttempt(deps: FinishMergeDeps): Promise<Record<string, unknown>> {
  let state: MergeWaitState = {};
  for (;;) {
    const step = await integrateAttemptOnce(deps, state);
    if (step.kind === "done") return step.result;
    if (deps.ctx.isDisposed()) return step.waitKind === "busy" ? { status: "blocked", reason: step.reason, attemptId: deps.input.attemptId, writerThreadId: deps.writerThreadId } : { status: "blocked", reason: step.reason, attemptId: deps.input.attemptId, writerThreadId: deps.writerThreadId };
    state = step.state;
    await new Promise((wake) => setTimeout(wake, step.waitKind === "busy" ? 20_000 : 60_000));
  }
}
