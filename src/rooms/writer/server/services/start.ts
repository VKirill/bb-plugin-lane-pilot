import { breakerKey, classifyFailure, tokenUsageFromEvent, type RunBudget } from "@lane-pilot/resilience";
import { isZcodeProvider } from "@lane-pilot/models";
import { getAttempt, onAttemptChanged } from "../../../storage";
import { closeOwnerItemsByPrefix } from "../../../owner-waiting";
import { usageHoldReason, usageSkipPercent } from "../../../usage/server";
import { copyRefusedKeyPrefix } from "../../models/copy-refused-key";
import { createWriterSticky } from "./sticky";

import type { BaselineApi } from "../../../baseline/server";
import type { MoneyApi } from "../../../money/server";
import type { OwnerPresenceApi } from "../../../owner-presence/server";
import type { RollbackApi } from "../../../rollback/server";
import type { ReconcileApi } from "../../../stability/server";
import type { StabilityPort } from "../../../contracts";
import type { WriterFinishApi } from "./finish";
import type { WriterSpawnApi } from "./spawn";
import type { WriterStateApi } from "./state";
import type { WriterVerifyApi } from "./verify";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface Services {
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  baseline: BaselineApi;
  concurrencyLimit: WriterStateApi["concurrencyLimit"];
  finishWriterAttempt: WriterFinishApi["finishWriterAttempt"];
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  probeLiveFolder?: WriterSpawnApi["probeLiveFolder"];
  invalidateLiveFolder?: WriterSpawnApi["invalidateLiveFolder"];
  money: MoneyApi;
  ownerPresence: OwnerPresenceApi;
  providerBreaker: WriterStateApi["providerBreaker"];
  providerRetry: WriterStateApi["providerRetry"];
  providerUsage: WriterStateApi["providerUsage"];
  reconcileAttemptThread: ReconcileApi["reconcileAttemptThread"];
  restoreLiveFolder: WriterSpawnApi["restoreLiveFolder"];
  rollback: RollbackApi;
  runBudgetFor: WriterStateApi["runBudgetFor"];
  runVerification: WriterVerifyApi["runVerification"];
  runWriterPool: WriterStateApi["runWriterPool"];
  spawnWriterAttempt: WriterSpawnApi["spawnWriterAttempt"];
  stability: StabilityPort;
  startAfterAcceptance: WorkflowEngineApi["startAfterAcceptance"];
  workspaceDirt: WriterSpawnApi["workspaceDirt"];
}

import { createStartWriterTask } from "./start-writer-task";
import { admittedByCore } from "../../models/start-admitted";

export { freshAttemptStart } from "./fresh-attempt-start";
export { CANCELED_REDO_WAIT_MS } from "./start-wait-limits";
export { sameArea } from "../../models/start-area";
export { copyRefusedKeyPrefix } from "../../models/copy-refused-key";

import type { ServerCore } from "../../../contracts/server";

import { mountWriterTaskFinished } from "./attempt-reactions";
import { mountStabilityAttemptFinished } from "./stability";

import type { WorkflowEngineApi } from "../../../platform/server";

export function createWriterStart(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  const sticky = createWriterSticky(ctx, services);
  // The task-finished reactions, in run order: stability's failure record, the area's writer record,
  // the after-acceptance graph (attempt-reactions.ts; the room-named mounts move to their owners).
  mountStabilityAttemptFinished(ctx, services);
  mountWriterTaskFinished(ctx, services, sticky);
  // A store-read block's owner item describes a blocked attempt: when the attempt leaves blocked (requeue,
  // accepted, canceled) the item closes; the next block posts under a fresh sequence key.
  bb.onDispose(onAttemptChanged(db, (changedId) => {
    const attempt = getAttempt(db, changedId);
    if (attempt && attempt.state !== "blocked") {
      closeOwnerItemsByPrefix(db, `store-read:${changedId}:`, "attempt left blocked");
      closeOwnerItemsByPrefix(db, copyRefusedKeyPrefix(attempt.run_id, attempt.task_id), "attempt left blocked");
    }
  }));
  const admitted = admittedByCore.get(ctx) ?? new Map<string, { runId:string; taskId:string; projectId:string }>();
  admittedByCore.set(ctx, admitted);

  /** The breaker learns from provider trouble only; the budget learns the thread's token total. */
  async function noteAttemptOutcome(input:{ budget:RunBudget; writerThreadId:string; writerSelection?:{providerId:string;model:string}; status:string; reason:string|null }): Promise<void> {
    if (input.writerSelection) {
      const key = breakerKey(input.writerSelection.providerId, input.writerSelection.model);
      const outcome = input.status === "accepted" || input.status === "validation_failed" || input.status === "empty_output"
        ? "ok"
        : classifyFailure(`${input.status}:${input.reason ?? ""}`);
      services.providerBreaker.record(key, outcome === "product" ? "ok" : outcome);
    }
    try {
      const listed = await bb.sdk.threads.events.list({ threadId:input.writerThreadId, types:["thread/tokenUsage/updated"], order:"desc", limit:"50" });
      const usage = Array.isArray(listed) ? tokenUsageFromEvent(listed[0]) : null;
      if (usage) input.budget.noteTokens(usage.threadId, usage.totalTokens);
    } catch {
      // Usage is informational; a host that cannot list events does not fail the attempt.
    }
  }

  /**
   * The chain entries whose provider usage window is not spent (provider-usage, I1); `room` says whether any is. When every
   * entry is spent the whole chain stays: the reading may be stale, and a spent window still fails in the provider's own
   * words, as before.
   */
  async function chainWithRoom<T extends { providerId:string; model:string }>(chain:T[], hostId:string, settings:Record<string, unknown>, taskId:string):Promise<{ chain:T[]; room:boolean; nextReset:string|null }> {
    const threshold = usageSkipPercent(settings);
    // The usage threshold can be 0 (the windows off); ZCode's own limits (host, free hours, one slot) still hold.
    if (!chain.length || (threshold <= 0 && !chain.some((entry) => isZcodeProvider(entry.providerId)))) return { chain, room:chain.length > 0, nextReset:null };
    const holds = await Promise.all(chain.map((entry) => services.providerUsage.hold({ providerId:entry.providerId, model:entry.model, hostId, threshold, settings })));
    const usable = chain.filter((_, index) => !holds[index]);
    if (usable.length) chain.forEach((entry, index) => { if (holds[index]) ctx.log(`writer ${taskId}: ${entry.providerId}/${entry.model} skipped, ${usageHoldReason(entry.providerId, entry.model, holds[index]!)}`); });
    const resets = holds.flatMap((hold) => (hold?.resetsAt ? [hold.resetsAt] : [])).sort();
    return usable.length ? { chain:usable, room:true, nextReset:resets[0] ?? null } : { chain, room:false, nextReset:resets[0] ?? null };
  }

  const startWriterTask = createStartWriterTask({ ctx, services, sticky, admitted, noteAttemptOutcome, chainWithRoom });

  return { startWriterTask };
}

export type WriterStartApi = ReturnType<typeof createWriterStart>;
