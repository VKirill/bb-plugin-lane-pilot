import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { LP_EVENTS } from "@lane-pilot/contracts";
import type { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { isTerminalAttemptState, type rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { attemptRowWithProject, onAttemptChanged } from "../../../storage";
import type { Canary } from "../services/canary";

export function canaryRpc(canary: Canary) {
  return { canary_status: async () => canary.status() } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "canary_status">;
}

export type CanaryAttemptFinishedSubscribe = (
  ctx: ServerCore,
  subscriber: (event: {
    scope: string;
    status: string;
    projectId: string;
    runId: string;
    taskId: string;
    pmThreadId: string;
    attemptId?: string;
  }) => void | Promise<void>,
  name?: string,
) => void;

export type CanaryMountDeps = {
  engine?: WorkflowEngine;
  emitEvent?: (name: string, payload?: Record<string, unknown>, options?: { id?: string; key?: string; projectId?: string }) => Promise<unknown>;
  onAttemptFinished?: CanaryAttemptFinishedSubscribe;
  unsubscribe?: { push: (fn: () => void) => void };
};

export function mountCanary(ctx: ServerCore, canary: Canary, deps?: CanaryMountDeps): () => void {
  deps?.engine?.register("lp.canary_check", {
    reentrant: true,
    run: async () => {
      try {
        const degraded = await canary.check();
        return { output: { degraded } };
      } catch (cause) {
        ctx.log(`Lane Pilot canary check skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
        return { output: { degraded: false } };
      }
    },
  });

  if (!deps?.emitEvent) return () => {};
  const emitted = new Set<string>();
  const recordAndEmit = (dedupeKey: string, attemptId: string | undefined, projectId: string | null, taskId: string, state: string) => {
    if (ctx.isDisposed() || !isTerminalAttemptState(state) || emitted.has(dedupeKey)) return;
    emitted.add(dedupeKey);
    if (emitted.size > 500) {
      const oldest = emitted.values().next().value;
      if (oldest !== undefined) emitted.delete(oldest);
    }
    void deps.emitEvent!(
      LP_EVENTS.ATTEMPT_FINISHED,
      { ...(attemptId ? { attemptId } : {}), taskId, state },
      {
        id: `${LP_EVENTS.ATTEMPT_FINISHED}:${dedupeKey}`,
        ...(projectId ? { projectId } : {}),
      },
    ).catch((cause) => {
      ctx.log(`Lane Pilot canary event failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  };

  deps.onAttemptFinished?.(ctx, (event) => {
    const dedupeKey = event.attemptId ? `attempt:${event.attemptId}` : `task:${event.runId}:${event.taskId}:${event.status}`;
    recordAndEmit(dedupeKey, event.attemptId, event.projectId, event.taskId, event.status);
  }, "canary-attempt-finished");

  const unsub = onAttemptChanged(ctx.db, (attemptId, state) => {
    const dedupeKey = `attempt:${attemptId}`;
    if (!state || !isTerminalAttemptState(state) || emitted.has(dedupeKey)) return;
    const row = attemptRowWithProject(ctx.db, attemptId);
    recordAndEmit(dedupeKey, attemptId, row?.project_id ?? null, row?.task_id ?? "", state);
  });
  deps.unsubscribe?.push(unsub);
  return unsub;
}
