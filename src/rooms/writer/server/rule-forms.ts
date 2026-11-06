import type { ServerCore, Services } from "../../core/server";
import { onAttemptFinished } from "./attempt-finished";

/**
 * MERGER: this file belongs to src/rooms/rule-forms (the promotion ledger). Move it there and call
 * `mountRuleFormsAttemptFinished(ctx, services)` from that room's mount code instead of writer's.
 *
 * The promotion ledger settles a task as failed when its running writer was stopped mid-wait — the
 * run's wall/token budget or the task's appetite ran out, or the owner deleted the queued follow-up
 * (finish.ts stopRunningWriter). Any other blocked outcome keeps its own record and settles nothing.
 */
export function mountRuleFormsAttemptFinished(ctx: ServerCore, services: Services): void {
  onAttemptFinished(ctx, (event) => {
    if (event.scope !== "attempt" || !event.writerStopped) return;
    services.promotions?.settleTask({ taskId: event.taskId, outcome: "failed", reason: event.reason ?? event.status });
  });
}
