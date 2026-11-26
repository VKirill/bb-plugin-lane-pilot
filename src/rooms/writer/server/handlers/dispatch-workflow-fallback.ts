import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { taskFamily } from "@lane-pilot/contracts";
import { id } from "@lane-pilot/kit";
import { resolveStageWriterSelection, rotatedWriterSettings, writerFallbackChain, writerFallbacks } from "@lane-pilot/models";
import { failureClass, WRITER_RETRY_LIMIT } from "../../../contracts";
import { postOwnerItem } from "../../../owner-waiting";
import { closeWriterStages } from "../../../runs/server";
import { countAttempts, countChargedAttempts, createAttempt, getAttempt, getRunSettingsScopes, listAttemptsForTask, loadProjectSettings, taskBasePath, transitionAttempt } from "../../../storage";
import { isLiveDecision } from "../../models/live-folder";
import { liveBackupKey } from "../services/start-live-folder";
import type { StepContext, WorkflowEngine } from "../../../workflow";
import { taskUsage } from "../services/attempt-usage";
import type { DispatchRuntime } from "../services/dispatch-runtime";
import { TERMINAL_ATTEMPT, reopenWriterStages } from "../services/dispatch-runtime";
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export { TERMINAL_ATTEMPT, WRITER_STAGES, reopenWriterStages } from "../services/dispatch-runtime";
export async function pollAttempt(engine: WorkflowEngine, runId: string, taskId: string, bb?: BbPluginApi) {
  const db = engine.journal.db;
  const attempts = listAttemptsForTask(db, runId, taskId);
  const listed = attempts.at(-1);
  const latest = listed ? getAttempt(db, listed.id) : null;
  if (!latest || !TERMINAL_ATTEMPT.includes(latest.state)) return null;
  const reasonStr = latest.reason ?? "";
  const cls = failureClass(latest.state, latest.reason);
  const nonRetryable = latest.state === "accepted"
    || latest.state === "canceled"
    || /needs[_ -]?human/i.test(reasonStr)
    || cls === "judgment"
    || cls === "budget"
    || reasonStr.startsWith("attempt_worktree_")
    || reasonStr.startsWith("retry_safety:");
  const exhaustedHere = !nonRetryable && countChargedAttempts(db, runId, taskId) >= WRITER_RETRY_LIMIT;
  const retryable = nonRetryable ? false : exhaustedHere ? undefined : true;
  return {
    output: {
      reply: {
        runId, taskId, attemptId: latest.id, state: latest.state,
        failureClass: cls, ...(retryable !== undefined ? { retryable } : {}),
        ...(latest.reason ? { reason: latest.reason } : {}),
      },
    },
    ...(bb ? await taskUsage(bb, db, runId, taskId) : {}),
  };
}

/** Registers the fallback-model rerun and owner-inbox escalation nodes used after `writer` exhausts its 3 pipeline visits. */
export function registerWriterFallbackExecutors(
  engine: WorkflowEngine,
  need: (ctx: StepContext<DispatchRuntime>) => DispatchRuntime,
  bb?: BbPluginApi,
): void {
  engine.register<DispatchRuntime>("lp.writer-fallback", {
    run: async (ctx) => {
      const r = need(ctx);
      const { db } = r.ctx;
      const latestRow = listAttemptsForTask(db, r.runId, r.taskId).at(-1);
      const curAttempt = latestRow ? getAttempt(db, latestRow.id) : null;
      const prev = (ctx.input.with.previousReply && typeof ctx.input.with.previousReply === "object"
        ? ctx.input.with.previousReply : {}) as Record<string, unknown>;
      const prevState = typeof prev.state === "string" ? prev.state : curAttempt?.state ?? "blocked";
      const prevReason = typeof prev.reason === "string" ? prev.reason : curAttempt?.reason ?? null;
      const loaded = loadProjectSettings(db, r.projectId, getRunSettingsScopes(db, r.runId));
      const rotated = rotatedWriterSettings(loaded, r.taskId);
      const primary = resolveStageWriterSelection({ settings: rotated, config: r.runConfig });
      const pmSelection = { providerId: r.runConfig.pmProviderId, model: r.runConfig.pmModel };
      const fallback = writerFallbackChain({ providerId: primary.providerId, model: primary.model }, writerFallbacks(rotated), pmSelection)[0];
      if (!fallback || prevState === "canceled") {
        if (curAttempt && isLiveDecision(curAttempt.workspace_decision)) {
          const restoreLive = (r.services as unknown as { restoreLiveFolder?: (input: { hostId: string; folder: string; backupId: string; task: { owns_paths: string[]; never_touch: string[] } }) => Promise<unknown> }).restoreLiveFolder;
          const backupId = ((await r.ctx.bb.storage?.kv?.get(liveBackupKey(curAttempt.id)).catch(() => null)) as string | null)
            ?? r.liveBackupByAttempt?.[curAttempt.id] ?? curAttempt.id;
          const folder = curAttempt.workspace_path ?? taskBasePath(db, r.runId, r.taskId) ?? r.workspacePath;
          if (typeof restoreLive === "function" && folder) {
            await restoreLive({ hostId: r.config.hostId, folder, backupId, task: r.task }).catch(() => undefined);
          }
        }
        if (curAttempt && !TERMINAL_ATTEMPT.includes(curAttempt.state)) {
          transitionAttempt(db, curAttempt.id, "blocked", { reason: prevReason ?? prevState });
        }
        closeWriterStages(db, {
          runId: r.runId,
          taskId: r.taskId,
          plan: r.plan,
          terminal: "failed",
          attempt: countAttempts(db, r.runId, r.taskId),
          threadId: curAttempt?.thread_id ?? null,
          reason: prevReason ?? prevState,
        });
        r.ctx.refreshRun?.(r.runId);
        return { output: { reply: { ...prev, runId: r.runId, taskId: r.taskId, state: prevState === "canceled" ? "canceled" : "blocked", retryable: false, fallbackSkipped: true } } };
      }
      const nextAttemptId = id("lpattempt");
      createAttempt(db, { id: nextAttemptId, runId: r.runId, taskId: r.taskId });
      reopenWriterStages(db, r.runId, r.taskId, r.plan);
      const pmReadContext = text(ctx.input.with.pmReadContext) ?? "";
      r.services.startWriterTask({
        projectId: r.projectId, runId: r.runId, taskId: r.taskId, firstAttemptId: nextAttemptId,
        pmThreadId: r.threadId, config: r.runConfig, task: r.task, plan: r.plan, pmReadContext: pmReadContext || undefined,
        singleAttempt: true,
        fallbackSelection: {
          providerId: fallback.providerId, model: fallback.model,
          ...(fallback.reasoningLevel ? { reasoningLevel: fallback.reasoningLevel } : {}),
          reason: "writer fallback rerun after 3 failed visits",
        },
      });
      return { wait: { kind: "attempt", detail: { runId: r.runId, taskId: r.taskId, attemptId: nextAttemptId } }, partial: { reply: { ...prev, attemptId: nextAttemptId, state: "queued" } } };
    },
    poll: async (step, ctx) => {
      const detail = step.await.detail as { runId: string; taskId: string } | undefined;
      if (!detail) return { error: "the waiting fallback step does not say which task it waits for" };
      return pollAttempt(engine, detail.runId, detail.taskId, bb ?? ctx.runtime?.ctx.bb);
    },
  });

  engine.register<DispatchRuntime>("lp.owner-backlog", {
    run: async (ctx) => {
      const r = need(ctx);
      const { db } = r.ctx;
      const reply = (ctx.input.with.reply && typeof ctx.input.with.reply === "object"
        ? ctx.input.with.reply : {}) as Record<string, unknown>;
      const state = typeof reply.state === "string" ? reply.state : "blocked";
      const reason = typeof reply.reason === "string" ? reply.reason : undefined;
      const cls = typeof reply.failureClass === "string" ? reply.failureClass : failureClass(state, reason ?? null);
      const attemptId = typeof reply.attemptId === "string" ? reply.attemptId : r.attemptId;
      postOwnerItem(db, {
        key: `writer-exhausted:${r.runId}:${taskFamily(r.taskId)}`,
        source: "writer",
        kind: "writer_exhausted",
        reason: "blocked",
        projectId: r.projectId,
        wake: false,
        what: "Задача не прошла после 3 попыток и запасной модели",
        why: `Класс сбоя: ${cls}. Последняя ошибка: ${(reason ?? state).slice(0, 400)}`,
        evidence: [{ kind: "run", ref: r.runId }, { kind: "task", ref: r.taskId }, ...(attemptId ? [{ kind: "attempt" as const, ref: attemptId }] : [])],
      });
      return { output: { reply: { ...reply, failureClass: cls, ownerInboxPosted: true } } };
    },
  });
}
