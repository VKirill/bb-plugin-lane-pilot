import { LP_EVENTS } from "@lane-pilot/contracts";
import { pollPause, stringAt } from "@lane-pilot/kit";
import { providerLimitNotice, resolveStageWriterSelection, roleFallbackModel, writerFallbackChain, writerFallbacks } from "@lane-pilot/models";
import { classifyFailure } from "@lane-pilot/resilience";
import type { ServerCore } from "../../../contracts/server";
import { getAttempt, getReasoningTrace, getRunSettingsScopes, loadProjectSettings } from "../../../storage";
import type { WorkflowEngine } from "../../../workflow";
import { noteRoleSwitch } from "../../../workflow/server";
import { WRITER_FALLBACK_ON_PROVIDER_FAILURE_KEY } from "../../settings";
import { emitAttemptEvent } from "./attempt-events";
import type { DispatchRuntime } from "./dispatch-runtime";
import { isWriterStreamError } from "../../models/writer-brief-feedback";

/** Bridges `threads.wait` / `threads.get` completion to `lp.thread.idle` when a real BB/fake host finishes a turn without emitting `bb.events("thread.idle")`. */
export function startThreadTurnWatcher(input: {
  bb: ServerCore["bb"];
  db: ServerCore["db"];
  engine: WorkflowEngine;
  attemptId: string;
  taskId: string;
  projectId: string;
  writerThreadId: string;
  isDisposed: () => boolean;
}): void {
  const { bb, db, engine, attemptId, taskId, projectId, writerThreadId, isDisposed } = input;
  void (async () => {
    // Allow `WorkflowEngine` to park `wait-turn` and settle `dispatch()`'s queued reply before emitting `THREAD_IDLE`.
    await new Promise((done) => setTimeout(done, 25));
    const waitFn = (bb.sdk.threads as { wait?: (args: { threadId: string }) => Promise<unknown> }).wait;
    let waitSettled = false;
    const waitPromise = typeof waitFn === "function"
      ? Promise.resolve().then(() => waitFn({ threadId: writerThreadId })).catch(() => undefined).finally(() => { waitSettled = true; })
      : null;
    while (!isDisposed() && !engine.stopped()) {
      const cur = getAttempt(db, attemptId);
      if (!cur || cur.state !== "running") return;
      const thread = await bb.sdk.threads.get({ threadId: writerThreadId }).catch(() => null);
      const status = stringAt(thread, "status");
      if (status !== "active" && status !== "running") {
        const woke = await emitAttemptEvent({
          db,
          engine,
          name: LP_EVENTS.THREAD_IDLE,
          key: writerThreadId,
          payload: { attemptId, taskId, threadId: writerThreadId, status: status ?? "idle" },
          projectId,
          now: engine.now(),
        });
        if (woke > 0) return;
      }
      const pauseMs = Math.min(150, pollPause(1_000));
      if (waitPromise && !waitSettled) {
        await Promise.race([waitPromise, new Promise((done) => setTimeout(done, pauseMs))]);
      } else {
        await new Promise((done) => setTimeout(done, pauseMs));
      }
    }
  })().catch(() => undefined);
}

/** Shared helper for auth/subscription/quota role fallback + single owner inbox item. */
export async function handleWriterSubscriptionFallback(
  r: DispatchRuntime,
  reason: string,
  now = Date.now(),
): Promise<boolean> {
  const cls = classifyFailure(reason);
  const subAuth = cls === "failure" && /\b(subscription|unauthori[sz]ed|invalid api key|auth|401|billing|account)\b/i.test(reason);
  const limit = providerLimitNotice(reason.slice(0, 400));
  if (!subAuth && !limit) return false;
  const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
  const trace = getReasoningTrace(r.ctx.db, r.attemptId);
  const failedProvider = trace?.providerId ?? r.config.writerProviderId;
  const failedModel = trace?.model ?? r.config.writerModel;
  const fb = roleFallbackModel("writer");
  if (!fb || fb.providerId === failedProvider) return false;
  await noteRoleSwitch({
    kv: r.ctx.bb.storage?.kv,
    db: r.ctx.db,
    log: r.ctx.bb.log,
    settings,
    role: "writer",
    failed: { providerId: failedProvider, model: failedModel },
    to: { providerId: fb.providerId, model: fb.model },
    reason,
    projectId: r.projectId,
  }, now);
  return true;
}

export function resolveWriterFallbackPlan(
  runSettings: Record<string, unknown>,
  runConfig: { writerProviderId: string; writerModel: string; pmProviderId: string; pmModel: string },
  prevReason: string | null | undefined,
  errCount: number,
  priorFailedState?: string,
) {
  const primary = resolveStageWriterSelection({ settings: runSettings, config: runConfig });
  const primaryPair = { providerId: primary.providerId, model: primary.model };
  const fallbackList = writerFallbackChain(primaryPair, writerFallbacks(runSettings), { providerId: runConfig.pmProviderId, model: runConfig.pmModel });
  const handOffAtOnce = runSettings[WRITER_FALLBACK_ON_PROVIDER_FAILURE_KEY] !== "after_retry" && !isWriterStreamError(prevReason);
  const useFallback = (errCount > 0 || priorFailedState === "provider_error") && fallbackList.length > 0 && (handOffAtOnce || errCount >= 2);
  return { fallbackList, useFallback };
}
