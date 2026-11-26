import { LP_EVENTS } from "@lane-pilot/contracts";
import { hasParkedWorkflowWait, type StepContext, type WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { sendOwnerBellNotice } from "../services/owner-bell-service";
import { onOwnerItemCreated, type OwnerItemSweep } from "../services/owner-items-service";
import { planBellNotice, seedBell } from "../services/owner-push-service";

export type OwnerBellDeps = {
  engine: WorkflowEngine;
  emitEvent?: (name: string, payload?: Record<string, unknown>, options?: { id?: string; key?: string; projectId?: string }) => Promise<unknown>;
  unsubscribe?: { push: (fn: () => void) => void };
};

/**
 * The bell «awaits a decision» (SMA m_ws_notify): driven by `lp.owner.item-created` through the `lp.owner-bell`
 * durable workflow graph. Quiet hours and post-cap items park on `builtin:wait` until the window opens, then overflow
 * items flush in one digest notification. Pre-existing open items are seeded at startup with yesterday's timestamp.
 */
export function mountOwnerBell(ctx: ServerCore, sweeps: readonly OwnerItemSweep[] = [], deps?: OwnerBellDeps): () => void {
  const nowFn = () => deps?.engine.now() ?? Date.now();
  seedBell(ctx.db, nowFn(), sweeps);

  if (deps?.engine) {
    deps.engine.register("lp.owner_bell_plan", {
      reentrant: true,
      run: async () => {
        const plan = planBellNotice(ctx.db, nowFn(), sweeps);
        if (plan.waitUntil !== undefined && !hasParkedWorkflowWait(ctx.db, "lp.owner-bell")) {
          return {
            output: {
              send: false,
              shouldWait: true,
              waitUntil: plan.waitUntil,
              digestOnWake: plan.reason === "daily_cap",
              reason: plan.reason ?? "",
            },
          };
        }
        return {
          output: {
            send: plan.send,
            shouldWait: false,
            waitUntil: null,
            digestOnWake: false,
            reason: (plan.waitUntil !== undefined ? "already_waiting" : plan.reason) ?? "",
          },
        };
      },
    });

    deps.engine.register("lp.owner_bell_send", {
      reentrant: true,
      run: async (step: StepContext) => {
        const params = ("params" in step.node ? step.node.params : undefined) ?? {};
        const bypassDailyCap = Boolean(params.bypassDailyCap);
        const includeLater = Boolean(params.includeLater);
        const outcome = await sendOwnerBellNotice(ctx, sweeps, nowFn(), { bypassDailyCap, includeLater });
        return { output: { sent: outcome.sent, reason: outcome.reason ?? "", count: outcome.count } };
      },
    });
  }

  if (!deps?.emitEvent) return () => {};
  const unsub = onOwnerItemCreated((event) => {
    if (ctx.isDisposed() || !event.wake) return;
    if (hasParkedWorkflowWait(ctx.db, "lp.owner-bell")) return;
    void deps.emitEvent!(
      LP_EVENTS.OWNER_ITEM_CREATED,
      { key: event.key, kind: event.kind },
      {
        id: `${LP_EVENTS.OWNER_ITEM_CREATED}:${event.key}:${event.now}`,
        ...(event.projectId ? { projectId: event.projectId } : {}),
      },
    ).catch((cause) => {
      ctx.log(`owner bell event failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  });
  deps.unsubscribe?.push(unsub);
  return unsub;
}
